import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolSpec } from "../agent/tools.js";
import type { ChatModel, ChatTurn, ToolCall } from "../graph/chat-graph.js";
import { conversationTurns, imageDataUrl, parseToolArguments } from "./content.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ModelInfo, ProviderSettings } from "./types.js";

// Sert à OpenAI et aux serveurs locaux compatibles (Ollama, vLLM, LM Studio).
function client(settings: ProviderSettings, timeout = settings.timeoutMs) {
  return new OpenAI({
    apiKey: settings.apiKey,
    ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
    maxRetries: 2,
    timeout,
  });
}

/**
 * Transcription neutre → messages OpenAI. Un appel d'outil est porté par le
 * message de l'assistant (tool_calls, arguments en texte JSON) ; chaque
 * résultat est un message de rôle « tool » relié par tool_call_id.
 */
export function toOpenAiMessages(turns: ChatTurn[]): ChatCompletionMessageParam[] {
  return turns.map((turn): ChatCompletionMessageParam => {
    if (turn.role === "tool") {
      return { role: "tool", tool_call_id: turn.toolCallId, content: turn.isError ? `[erreur] ${turn.content}` : turn.content };
    }
    if (turn.role === "assistant") {
      return {
        role: "assistant",
        content: turn.content || null,
        ...(turn.toolCalls?.length
          ? {
              tool_calls: turn.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}) },
              })),
            }
          : {}),
      };
    }
    return {
      role: "user",
      content: turn.images?.length
        ? [{ type: "text", text: turn.content }, ...turn.images.map((image) => ({ type: "image_url" as const, image_url: { url: imageDataUrl(image) } }))]
        : turn.content,
    };
  });
}

export const toOpenAiTools = (tools: ToolSpec[]): ChatCompletionTool[] =>
  tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));

export function createOpenAiCompatibleModel(
  provider: "openai" | "local",
  model: string,
  settings: ProviderSettings,
  options: { tools?: boolean } = {},
): ChatModel {
  const openai = client(settings);

  return {
    id: `${provider}:${model}`,
    // Les serveurs locaux ne gèrent pas tous les outils : activé par la configuration.
    supportsTools: provider === "openai" || options.tools === true,

    async *stream(request, signal) {
      const stream = await openai.chat.completions.create(
        {
          model,
          stream: true,
          stream_options: { include_usage: true },
          // Les serveurs locaux ne connaissent souvent que max_tokens.
          ...(provider === "openai"
            ? { max_completion_tokens: settings.maxOutputTokens }
            : { max_tokens: settings.maxOutputTokens }),
          messages: [{ role: "system", content: buildSystemPrompt(request.instructions) }, ...toOpenAiMessages(conversationTurns(request))],
          ...(request.tools?.length ? { tools: toOpenAiTools(request.tools) } : {}),
        },
        signal ? { signal } : {},
      );

      // Les appels d'outils arrivent par fragments, indexés : on les reconstitue.
      const pending = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) yield { type: "token", text: delta.content };
        for (const part of delta?.tool_calls ?? []) {
          const current = pending.get(part.index) ?? { id: "", name: "", arguments: "" };
          if (part.id) current.id = part.id;
          if (part.function?.name) current.name += part.function.name;
          if (part.function?.arguments) current.arguments += part.function.arguments;
          pending.set(part.index, current);
        }
        if (chunk.usage) {
          yield { type: "usage", inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }
      }

      for (const [index, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        const toolCall: ToolCall = { id: call.id || `call_${index}`, name: call.name, arguments: parseToolArguments(call.arguments) };
        yield { type: "tool_call", call: toolCall };
      }
    },
  };
}

// L'API OpenAI liste aussi les modèles audio, image, embeddings… : on ne
// garde que les modèles de chat textuel.
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_EXCLUDED = /(audio|realtime|tts|transcribe|whisper|image|embedding|search|instruct|moderation|codex|computer)/;

export async function listOpenAiCompatibleModels(
  provider: "openai" | "local",
  settings: ProviderSettings,
): Promise<ModelInfo[]> {
  const ids: string[] = [];
  for await (const item of client(settings, 5_000).models.list()) ids.push(item.id);

  return ids
    .filter((id) => provider === "local" || (OPENAI_CHAT.test(id) && !OPENAI_EXCLUDED.test(id)))
    .sort()
    .reverse()
    .map((id) => ({ id, label: id }));
}
