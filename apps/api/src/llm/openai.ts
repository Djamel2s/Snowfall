import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ChatModel } from "../graph/chat-graph.js";
import { conversationTurns, imageDataUrl } from "./content.js";
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

export function createOpenAiCompatibleModel(
  provider: "openai" | "local",
  model: string,
  settings: ProviderSettings,
): ChatModel {
  const openai = client(settings);

  return {
    id: `${provider}:${model}`,

    async *stream(request, signal) {
      const turns: ChatCompletionMessageParam[] = conversationTurns(request).map((turn) =>
        turn.role === "assistant"
          ? { role: "assistant", content: turn.content }
          : {
              role: "user",
              content: turn.images?.length
                ? [
                    { type: "text", text: turn.content },
                    ...turn.images.map((image) => ({
                      type: "image_url" as const,
                      image_url: { url: imageDataUrl(image) },
                    })),
                  ]
                : turn.content,
            },
      );

      const stream = await openai.chat.completions.create(
        {
          model,
          stream: true,
          stream_options: { include_usage: true },
          // Les serveurs locaux ne connaissent souvent que max_tokens.
          ...(provider === "openai"
            ? { max_completion_tokens: settings.maxOutputTokens }
            : { max_tokens: settings.maxOutputTokens }),
          messages: [
            { role: "system", content: buildSystemPrompt(request.instructions) },
            ...turns,
          ],
        },
        signal ? { signal } : {},
      );

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) yield { type: "token", text };

        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
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
