import { ModelRefusalError, type ChatModel } from "../graph/chat-graph.js";
import { conversationTurns } from "./content.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ModelInfo, ProviderSettings } from "./types.js";

// API REST Gemini appelée directement (pas de SDK : deux appels ne justifient
// pas une dizaine de dépendances). La clé passe en en-tête, jamais dans l'URL,
// pour ne pas finir dans des journaux.
const API = "https://generativelanguage.googleapis.com/v1beta";

type GeminiChunk = {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

// Arrêts imposés par les filtres de Google : traités comme un refus du modèle.
const BLOCKED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);
const RETRYABLE = new Set([429, 500, 503]);

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
      throw new Error(`GOOGLE_${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
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

export function createGoogleModel(model: string, settings: ProviderSettings): ChatModel {
  return {
    id: `google:${model}`,

    async *stream(chat, signal) {
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const response = await request(
        // L'identifiant vient de la liste blanche ; encodé par sécurité.
        `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: buildSystemPrompt(chat.instructions) }] },
            contents: conversationTurns(chat).map((turn) => ({
              role: turn.role === "assistant" ? "model" : "user",
              parts: [
                ...(turn.images ?? []).map((image) => ({
                  inlineData: { mimeType: image.mediaType, data: image.data },
                })),
                { text: turn.content },
              ],
            })),
            generationConfig: { maxOutputTokens: settings.maxOutputTokens, temperature: 0.3 },
          }),
        },
        settings.apiKey,
      );
      if (!response.body) throw new Error("GOOGLE_EMPTY_STREAM");

      let usage: GeminiChunk["usageMetadata"];
      for await (const chunk of sseEvents(response.body)) {
        if (chunk.promptFeedback?.blockReason) throw new ModelRefusalError();

        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          // Les parties « thought » (raisonnement) ne sont pas affichées.
          if (part.text && !part.thought) yield { type: "token", text: part.text };
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
