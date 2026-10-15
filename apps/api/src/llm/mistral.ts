import { ChatMistralAI } from "@langchain/mistralai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatModel } from "../graph/chat-graph.js";
import { conversationTurns, imageDataUrl } from "./content.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ModelInfo, ProviderSettings } from "./types.js";

export function createMistralModel(model: string, settings: ProviderSettings): ChatModel {
  const llm = new ChatMistralAI({
    apiKey: settings.apiKey,
    model,
    maxTokens: settings.maxOutputTokens,
    temperature: 0.3,
    maxRetries: 2,
    streamUsage: true,
  });

  return {
    id: `mistral:${model}`,

    async *stream(request, signal) {
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const stream = await llm.stream(
        [
          new SystemMessage(buildSystemPrompt(request.instructions)),
          ...conversationTurns(request).map((turn) =>
            turn.role === "assistant"
              ? new AIMessage(turn.content)
              : new HumanMessage({
                  content: turn.images?.length
                    ? [
                        { type: "text", text: turn.content },
                        ...turn.images.map((image) => ({ type: "image_url", image_url: imageDataUrl(image) })),
                      ]
                    : turn.content,
                }),
          ),
        ],
        { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
      );

      for await (const chunk of stream) {
        const text =
          typeof chunk.content === "string"
            ? chunk.content
            : chunk.content
                .map((part) => (part.type === "text" && "text" in part ? String(part.text) : ""))
                .join("");

        if (text) yield { type: "token", text };

        const usage = (chunk as unknown as {
          usage_metadata?: { input_tokens: number; output_tokens: number };
        }).usage_metadata;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          };
        }
      }
    },
  };
}

type MistralModel = {
  id: string;
  name?: string;
  deprecation?: string | null;
  capabilities?: { completion_chat?: boolean };
};

export async function listMistralModels(settings: ProviderSettings): Promise<ModelInfo[]> {
  const response = await fetch("https://api.mistral.ai/v1/models", {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`MISTRAL_MODELS_${response.status}`);

  const { data } = (await response.json()) as { data: MistralModel[] };
  const chat = data.filter((item) => item.capabilities?.completion_chat && !item.deprecation);
  // Les alias "-latest" suivent automatiquement les nouvelles versions.
  const latest = chat.filter((item) => item.id.endsWith("-latest"));

  return [...new Set((latest.length ? latest : chat).map((item) => item.id))]
    .sort()
    .map((id) => ({ id, label: id.replace(/-latest$/, "") }));
}
