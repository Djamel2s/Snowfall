import Anthropic from "@anthropic-ai/sdk";
import type { ToolSpec } from "../agent/tools.js";
import { ModelRefusalError, type ChatModel, type ChatTurn } from "../graph/chat-graph.js";
import { conversationTurns } from "./content.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ModelInfo, ProviderSettings } from "./types.js";

// Modèles qui acceptent le repli serveur automatique en cas de refus
// (fallbacks: "default"). Claude Haiku n'en a pas.
const SERVER_FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
// Génération 5 : réglage d'effort disponible ; "medium" convient au chat.
const SUPPORTS_EFFORT = /^claude-(fable|opus|sonnet|haiku)-5/;

/**
 * Transcription neutre → messages Anthropic. Un appel d'outil est un bloc
 * « tool_use » dans la réponse de l'assistant ; son résultat, un bloc
 * « tool_result » dans le message utilisateur suivant (les résultats d'une
 * même étape sont regroupés dans un seul message).
 */
export function toAnthropicMessages(turns: ChatTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === "tool") {
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: turn.toolCallId,
        content: turn.content,
        ...(turn.isError ? { is_error: true } : {}),
      };
      const last = messages.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((item) => item.type === "tool_result")) {
        last.content.push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
    } else if (turn.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [
        ...(turn.content ? [{ type: "text" as const, text: turn.content }] : []),
        ...(turn.toolCalls ?? []).map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          input: (call.arguments ?? {}) as Record<string, unknown>,
        })),
      ];
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
    } else {
      messages.push({
        role: "user",
        content: turn.images?.length
          ? [
              // Images avant le texte, comme le recommande la documentation.
              ...turn.images.map((image) => ({
                type: "image" as const,
                source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
              })),
              { type: "text" as const, text: turn.content },
            ]
          : turn.content,
      });
    }
  }
  return messages;
}

export const toAnthropicTools = (tools: ToolSpec[]): Anthropic.Tool[] =>
  tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Tool.InputSchema }));

export function createAnthropicModel(model: string, settings: ProviderSettings): ChatModel {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    maxRetries: 2,
    timeout: settings.timeoutMs,
  });

  return {
    id: `anthropic:${model}`,
    supportsTools: true,

    async *stream(request, signal) {
      const params = {
        model,
        max_tokens: settings.maxOutputTokens,
        system: buildSystemPrompt(request.instructions),
        messages: toAnthropicMessages(conversationTurns(request)),
        ...(request.tools?.length ? { tools: toAnthropicTools(request.tools) } : {}),
        ...(SUPPORTS_EFFORT.test(model) ? { output_config: { effort: "medium" as const } } : {}),
      };
      const options = signal ? { signal } : {};

      const stream = SERVER_FALLBACK.test(model)
        ? client.beta.messages.stream(
            { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
            options,
          )
        : client.messages.stream(params, options);

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "token", text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") throw new ModelRefusalError();

      // Appels d'outils complets (arguments déjà assemblés par le SDK).
      for (const block of final.content) {
        if (block.type === "tool_use") yield { type: "tool_call", call: { id: block.id, name: block.name, arguments: block.input } };
      }

      yield {
        type: "usage",
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };
    },
  };
}

export async function listAnthropicModels(settings: ProviderSettings): Promise<ModelInfo[]> {
  const client = new Anthropic({ apiKey: settings.apiKey, maxRetries: 1, timeout: 5_000 });
  const models: ModelInfo[] = [];

  for await (const item of client.models.list()) {
    models.push({ id: item.id, label: item.display_name.replace(/^Claude /, "") });
  }
  return models;
}
