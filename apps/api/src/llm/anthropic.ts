import Anthropic from "@anthropic-ai/sdk";
import { ModelRefusalError, type ChatModel } from "../graph/chat-graph.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ModelInfo, ProviderSettings } from "./types.js";

// Modèles qui acceptent le repli serveur automatique en cas de refus
// (fallbacks: "default"). Claude Haiku n'en a pas.
const SERVER_FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
// Génération 5 : réglage d'effort disponible ; "medium" convient au chat.
const SUPPORTS_EFFORT = /^claude-(fable|opus|sonnet|haiku)-5/;

export function createAnthropicModel(model: string, settings: ProviderSettings): ChatModel {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    maxRetries: 2,
    timeout: settings.timeoutMs,
  });

  return {
    id: `anthropic:${model}`,

    async *stream({ history, message, instructions }, signal) {
      const params = {
        model,
        max_tokens: settings.maxOutputTokens,
        system: buildSystemPrompt(instructions),
        messages: [
          ...history.map((turn) => ({ role: turn.role, content: turn.content })),
          { role: "user" as const, content: message },
        ],
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
