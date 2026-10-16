import type { ToolSpec } from "../agent/tools.js";
import { ModelRefusalError, ProviderRateLimitError, type ChatModel, type ChatTurn } from "../graph/chat-graph.js";
import { conversationTurns } from "./content.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ModelInfo, ProviderSettings } from "./types.js";

// API REST Gemini appelée directement (pas de SDK : deux appels ne justifient
// pas une dizaine de dépendances). La clé passe en en-tête, jamais dans l'URL,
// pour ne pas finir dans des journaux.
const API = "https://generativelanguage.googleapis.com/v1beta";

type GeminiPart = {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  /** Signature du raisonnement : à renvoyer telle quelle avec l'appel d'outil. */
  thoughtSignature?: string;
};

type GeminiChunk = {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    /** Part du prompt servie par le cache implicite de Gemini (incluse dans promptTokenCount). */
    cachedContentTokenCount?: number;
  };
};

// Arrêts imposés par les filtres de Google : traités comme un refus du modèle.
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);
const RETRYABLE = new Set([429, 500, 503]);
// Réflexion (résumée) demandée pour l'afficher, sauf aux anciennes générations qui ne raisonnent pas.
// Liste d'exclusion : les alias (gemini-flash-latest…) et les nouveaux modèles sont couverts.
const NO_THINKING = /^gemini-(1\.|2\.0)/;

async function request(path: string, init: RequestInit, apiKey: string, attempts = 3): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${API}/${path}`, {
      ...init,
      headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    });
    if (response.ok) return response;

    // Corps d'erreur volontairement ignoré : il peut refléter la requête.
    await response.body?.cancel();
    if (!RETRYABLE.has(response.status) || attempt >= attempts || init.signal?.aborted) {
      if (response.status === 429) throw new ProviderRateLimitError();
      throw new Error(`GOOGLE_${response.status}`);
    }
    // Délai demandé par Google s'il est indiqué (borné à 10 s), sinon attente croissante.
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 400 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Découpe un flux SSE en objets JSON (`data: {...}`). */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<GeminiChunk> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) yield JSON.parse(data) as GeminiChunk;
    }
  }
}

/**
 * Transcription neutre → « contents » Gemini. Un appel d'outil est une partie
 * functionCall du tour « model » (avec sa signature de raisonnement, exigée
 * par Gemini 3) ; les résultats d'une étape sont des parties functionResponse
 * regroupées dans un seul tour « user ».
 */
export function toGeminiContents(turns: ChatTurn[]) {
  const contents: { role: "user" | "model"; parts: Record<string, unknown>[] }[] = [];
  for (const turn of turns) {
    if (turn.role === "tool") {
      const part = {
        functionResponse: {
          id: turn.toolCallId,
          name: turn.name,
          response: turn.isError ? { error: turn.content } : { content: turn.content },
        },
      };
      const last = contents.at(-1);
      if (last?.role === "user" && last.parts.every((item) => "functionResponse" in item)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
    } else if (turn.role === "assistant") {
      const parts: Record<string, unknown>[] = [
        ...(turn.content ? [{ text: turn.content }] : []),
        ...(turn.toolCalls ?? []).map((call) => ({
          functionCall: { id: call.id, name: call.name, args: call.arguments ?? {} },
          ...(typeof call.providerData?.thoughtSignature === "string" ? { thoughtSignature: call.providerData.thoughtSignature } : {}),
        })),
      ];
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      contents.push({
        role: "user",
        parts: [
          ...(turn.images ?? []).map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } })),
          { text: turn.content },
        ],
      });
    }
  }
  return contents;
}

// Schéma JSON complet (parametersJsonSchema), pas le sous-ensemble OpenAPI.
const toGeminiTools = (tools: ToolSpec[]) => [
  { functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters })) },
];

export function createGoogleModel(model: string, settings: ProviderSettings): ChatModel {
  return {
    id: `google:${model}`,
    supportsTools: true,

    async *stream(chat, signal) {
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const response = await request(
        // L'identifiant vient de la liste blanche ; encodé par sécurité.
        `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          body: JSON.stringify({
            // Début de requête stable (prompt système, puis historique) : le cache implicite de Gemini s'applique.
            systemInstruction: { parts: [{ text: buildSystemPrompt(chat.instructions, chat.summary) }] },
            contents: toGeminiContents(conversationTurns(chat)),
            ...(chat.tools?.length ? { tools: toGeminiTools(chat.tools) } : {}),
            generationConfig: {
              maxOutputTokens: settings.maxOutputTokens,
              temperature: 0.3,
              ...(NO_THINKING.test(model) ? {} : { thinkingConfig: { includeThoughts: true } }),
            },
          }),
        },
        settings.apiKey,
      );
      if (!response.body) throw new Error("GOOGLE_EMPTY_STREAM");

      let usage: GeminiChunk["usageMetadata"];
      let calls = 0;
      for await (const chunk of sseEvents(response.body)) {
        if (chunk.promptFeedback?.blockReason) throw new ModelRefusalError();

        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          // Parties « thought » : résumé de la réflexion, affiché à part, jamais dans la réponse.
          if (part.text) yield part.thought ? { type: "reasoning", text: part.text } : { type: "token", text: part.text };
          if (part.functionCall) {
            calls += 1;
            yield {
              type: "tool_call",
              call: {
                id: part.functionCall.id ?? `call_${calls}`,
                name: part.functionCall.name,
                arguments: part.functionCall.args ?? {},
                ...(part.thoughtSignature ? { providerData: { thoughtSignature: part.thoughtSignature } } : {}),
              },
            };
          }
        }
        if (candidate?.finishReason && BLOCKED.has(candidate.finishReason)) throw new ModelRefusalError();
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
      }

      if (usage) {
        yield {
          type: "usage",
          inputTokens: usage.promptTokenCount ?? 0,
          // Le raisonnement est facturé comme de la sortie.
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          ...(usage.cachedContentTokenCount ? { cachedInputTokens: usage.cachedContentTokenCount } : {}),
        };
      }
    },
  };
}

type GeminiModel = { name: string; displayName?: string; supportedGenerationMethods?: string[] };

// L'API liste aussi embeddings, image, audio, temps réel… : on ne garde que le chat
// textuel, sans les versions figées (-001) qui doublonnent les alias.
const EXCLUDED = /(embedding|image|tts|audio|live|native|aqa|robotics|computer-use|-\d{3}$)/;

export async function listGoogleModels(settings: ProviderSettings): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let pageToken = "";

  do {
    const response = await request(
      `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      { method: "GET", signal: AbortSignal.timeout(5_000) },
      settings.apiKey,
      1,
    );
    const page = (await response.json()) as { models?: GeminiModel[]; nextPageToken?: string };

    for (const item of page.models ?? []) {
      const id = item.name.replace(/^models\//, "");
      if (!id.startsWith("gemini-") || EXCLUDED.test(id)) continue;
      if (!item.supportedGenerationMethods?.includes("generateContent")) continue;
      models.push({ id, label: id.replace(/^gemini-/, "") });
    }
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);

  return models.sort((a, b) => b.id.localeCompare(a.id));
}
