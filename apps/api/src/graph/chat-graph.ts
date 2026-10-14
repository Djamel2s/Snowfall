import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type ChatChunk =
  | { type: "token"; text: string }
  | ({ type: "usage" } & TokenUsage);

export type ChatRequest = {
  history: ChatTurn[];
  message: string;
  /** Instructions de l'agent, ajoutées au prompt système de la plateforme. */
  instructions?: string | undefined;
};

export interface ChatModel {
  /** Identifiant tracé dans l'audit, ex. "mistral:mistral-small-latest". */
  readonly id: string;
  stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}

/** Le modèle a décliné la demande (filtres de sécurité du fournisseur). */
export class ModelRefusalError extends Error {
  constructor() {
    super("MODEL_REFUSAL");
  }
}

export type ChatResult = {
  content: string;
  model: string;
  usage?: TokenUsage;
};

export type ChatRunner = (
  input: { message: string; history?: ChatTurn[]; instructions?: string | undefined },
  options?: { onToken?: (text: string) => void; signal?: AbortSignal },
) => Promise<ChatResult>;

/** Modèle de développement : aucune donnée ne sort de la machine. */
export const echoModel: ChatModel = {
  id: "echo",
  async *stream({ message }) {
    const words = `Snowfall a reçu ton message : ${message}`.split(/(?<= )/);
    for (const word of words) yield { type: "token", text: word };
  },
};

const ChatState = Annotation.Root({
  message: Annotation<string>,
  history: Annotation<ChatTurn[]>,
  response: Annotation<string>,
  usage: Annotation<TokenUsage | undefined>,
  instructions: Annotation<string | undefined>,
});

export function buildChatGraph(model: ChatModel = echoModel) {
  return new StateGraph(ChatState)
    .addNode("generate", async (state, config) => {
      let response = "";
      let usage: TokenUsage | undefined;

      const request = {
        history: state.history,
        message: state.message,
        instructions: state.instructions,
      };

      for await (const chunk of model.stream(request, config.signal)) {
        if (chunk.type === "token") {
          response += chunk.text;
          config.writer?.({ token: chunk.text });
        } else {
          usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
        }
      }

      return { response, usage };
    })
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile();
}

export function createChatRunner(model: ChatModel = echoModel): ChatRunner {
  const graph = buildChatGraph(model);

  return async (input, options = {}) => {
    const stream = await graph.stream(
      {
        message: input.message,
        history: input.history ?? [],
        instructions: input.instructions,
        response: "",
        usage: undefined,
      },
      {
        streamMode: ["custom", "values"],
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    let final: { response: string; usage?: TokenUsage | undefined } | undefined;

    for await (const [mode, chunk] of stream) {
      if (mode === "custom") {
        const token = (chunk as { token?: unknown }).token;
        if (typeof token === "string") options.onToken?.(token);
      } else {
        final = chunk as typeof final;
      }
    }

    const content = final?.response.trim() ?? "";
    if (!content) throw new Error("EMPTY_MODEL_RESPONSE");

    return {
      content: final!.response,
      model: model.id,
      ...(final?.usage ? { usage: final.usage } : {}),
    };
  };
}
