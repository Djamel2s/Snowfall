import { ChatMistralAI } from "@langchain/mistralai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { ToolSpec } from "../agent/tools.js";
import type { ChatModel, ChatTurn, GenerationOptions } from "../graph/chat-graph.js";
import { conversationTurns, imageDataUrl } from "./content.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { ModelInfo, ProviderSettings } from "./types.js";

/** Transcription neutre → messages LangChain (AIMessage avec tool_calls, ToolMessage). */
export function toMistralMessages(turns: ChatTurn[]): BaseMessage[] {
  return turns.map((turn) => {
    if (turn.role === "tool") {
      return new ToolMessage({ content: turn.content, tool_call_id: turn.toolCallId, name: turn.name, ...(turn.isError ? { status: "error" as const } : {}) });
    }
    if (turn.role === "assistant") {
      return new AIMessage({
        content: turn.content,
        tool_calls: (turn.toolCalls ?? []).map((call) => ({
          id: call.id,
          name: call.name,
          args: (call.arguments ?? {}) as Record<string, unknown>,
          type: "tool_call" as const,
        })),
      });
    }
    return new HumanMessage({
      content: turn.images?.length
        ? [{ type: "text", text: turn.content }, ...turn.images.map((image) => ({ type: "image_url", image_url: imageDataUrl(image) }))]
        : turn.content,
    });
  });
}

const toMistralTools = (tools: ToolSpec[]) =>
  tools.map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));

export function createMistralModel(model: string, settings: ProviderSettings): ChatModel {
  // Un client par combinaison de réglages (température, longueur) : peu nombreuses.
  const clients = new Map<string, ChatMistralAI>();
  const clientFor = (generation: GenerationOptions | undefined) => {
    const temperature = generation?.temperature ?? 0.3;
    const maxTokens = Math.min(generation?.maxOutputTokens ?? settings.maxOutputTokens, settings.maxOutputTokens);
    const key = `${temperature}:${maxTokens}`;
    let llm = clients.get(key);
    if (!llm) {
      llm = new ChatMistralAI({ apiKey: settings.apiKey, model, maxTokens, temperature, maxRetries: 2, streamUsage: true });
      clients.set(key, llm);
    }
    return llm;
  };

  return {
    id: `mistral:${model}`,
    supportsTools: true,

    async *stream(request, signal) {
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const llm = clientFor(request.generation);
      const runnable = request.tools?.length ? llm.bindTools(toMistralTools(request.tools)) : llm;
      const stream = await runnable.stream(
        [new SystemMessage(buildSystemPrompt(request.instructions, request.summary, request.memories, request.profile)), ...toMistralMessages(conversationTurns(request))],
        { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
      );

      // Les fragments s'additionnent : à la fin, les appels d'outils sont complets.
      let full: AIMessageChunk | undefined;
      for await (const chunk of stream) {
        full = full ? full.concat(chunk) : chunk;
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

      // Fin de réponse : longueur maximale (de la requête ou du modèle) atteinte.
      const finish = (full?.response_metadata as { finishReason?: string } | undefined)?.finishReason;
      if (finish === "length" || finish === "model_length") yield { type: "truncated" };

      for (const call of full?.tool_calls ?? []) {
        yield { type: "tool_call", call: { id: call.id ?? `call${Math.random().toString(36).slice(2, 7)}`, name: call.name, arguments: call.args } };
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
