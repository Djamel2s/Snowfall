import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { runTool, toolSpec, type AgentTool, type ToolSpec } from "../agent/tools.js";

/** Image jointe, transmise en base64 aux modèles multimodaux. */
export type ModelImage = { mediaType: "image/png" | "image/jpeg" | "image/webp"; data: string };

/**
 * Appel d'outil demandé par le modèle. providerData garde ce que certains
 * fournisseurs exigent de recevoir à nouveau tel quel (ex. signature de
 * raisonnement de Gemini).
 */
export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  providerData?: Record<string, unknown>;
};

/**
 * Tour de conversation, sous une forme neutre que chaque adaptateur traduit
 * dans le format de son fournisseur. Le texte des documents joints est déjà
 * intégré à content (balises <document>) ; les images sont passées à part.
 */
export type ChatTurn =
  | { role: "user"; content: string; images?: ModelImage[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type ChatChunk =
  | { type: "token"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | ({ type: "usage" } & TokenUsage);

export type ChatRequest = {
  history: ChatTurn[];
  message: string;
  /** Images jointes au message courant. */
  images?: ModelImage[] | undefined;
  /** Instructions de l'agent, ajoutées au prompt système de la plateforme. */
  instructions?: string | undefined;
  /** Transcription complète (boucle d'agent) : remplace history + message. */
  turns?: ChatTurn[] | undefined;
  /** Outils proposés au modèle pour ce tour. */
  tools?: ToolSpec[] | undefined;
};

export interface ChatModel {
  /** Identifiant tracé dans l'audit, ex. "mistral:mistral-small-latest". */
  readonly id: string;
  /** Le modèle sait demander des appels d'outils. */
  readonly supportsTools?: boolean;
  stream(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}

/** Le fournisseur limite le débit (HTTP 429 : quota par minute ou par jour atteint). */
export class ProviderRateLimitError extends Error {
  constructor() {
    super("PROVIDER_RATE_LIMITED");
  }
}

/**
 * Erreur 429 d'un fournisseur, quelle que soit sa forme : erreur dédiée,
 * erreur des SDK OpenAI / Anthropic / Mistral (champ status), ou code texte.
 */
export function isRateLimit(error: unknown): boolean {
  if (error instanceof ProviderRateLimitError) return true;
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (status === 429) return true;
  const message = error instanceof Error ? error.message : "";
  return /\b429\b|rate.?limit|too many requests/i.test(message);
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
  /** Étapes (appels d'outils) effectuées pour produire la réponse. */
  steps?: number;
};

/** Événement d'outil diffusé à l'interface pendant l'exécution. */
export type ToolEvent = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary?: string | undefined;
};

export type ChatRunner = (
  input: {
    message: string;
    history?: ChatTurn[];
    images?: ModelImage[] | undefined;
    instructions?: string | undefined;
    /** Outils disponibles : active la boucle d'agent. */
    tools?: AgentTool[] | undefined;
    /** Nombre maximal d'aller-retour modèle ↔ outils. */
    maxSteps?: number | undefined;
  },
  options?: { onToken?: (text: string) => void; onTool?: (event: ToolEvent) => void; signal?: AbortSignal },
) => Promise<ChatResult>;

/** Appels d'outils exécutés en parallèle par étape (au-delà, refusés). */
export const MAX_TOOL_CALLS_PER_STEP = 8;
export const DEFAULT_MAX_STEPS = 6;

/** Modèle de développement : aucune donnée ne sort de la machine. */
export const echoModel: ChatModel = {
  id: "echo",
  async *stream({ message, turns }) {
    const last = turns ? [...turns].reverse().find((turn) => turn.role === "user")?.content : message;
    const words = `Snowfall a reçu ton message : ${last ?? ""}`.split(/(?<= )/);
    for (const word of words) yield { type: "token", text: word };
  },
};

const sum = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined =>
  a || b ? { inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0), outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0) } : undefined;

const AgentState = Annotation.Root({
  /** Transcription : historique, message, puis réponses et résultats d'outils. */
  turns: Annotation<ChatTurn[]>,
  instructions: Annotation<string | undefined>,
  /** Texte visible produit par le modèle, toutes étapes confondues. */
  response: Annotation<string>,
  usage: Annotation<TokenUsage | undefined>,
  /** Aller-retour modèle → outils déjà effectués. */
  steps: Annotation<number>,
});

/**
 * Boucle d'agent :
 *
 *   START → model ──(appels d'outils ?)──► tools ──► model … ──► END
 *
 * Le nœud « model » demande une réponse ; s'il réclame des outils, le nœud
 * « tools » les exécute et ajoute leurs résultats à la transcription, puis on
 * revient au modèle. Au-delà de maxSteps, le modèle est rappelé SANS outils :
 * il doit conclure avec ce qu'il a.
 */
export function buildAgentGraph(model: ChatModel, tools: AgentTool[], maxSteps: number) {
  const specs = tools.map(toolSpec);
  const lastCalls = (turns: ChatTurn[]) => {
    const last = turns.at(-1);
    return last?.role === "assistant" ? (last.toolCalls ?? []) : [];
  };

  return new StateGraph(AgentState)
    .addNode("model", async (state, config) => {
      let text = "";
      let usage: TokenUsage | undefined;
      const calls: ToolCall[] = [];
      const offerTools = specs.length > 0 && model.supportsTools && state.steps < maxSteps;

      const request: ChatRequest = {
        history: [],
        message: "",
        turns: state.turns,
        instructions: state.instructions,
        ...(offerTools ? { tools: specs } : {}),
      };
      for await (const chunk of model.stream(request, config.signal)) {
        if (chunk.type === "token") {
          text += chunk.text;
          config.writer?.({ token: chunk.text });
        } else if (chunk.type === "tool_call") {
          calls.push(chunk.call);
        } else {
          usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
        }
      }

      const turn: ChatTurn = { role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) };
      // Le texte d'une étape d'outil (« Je vais chercher… ») est séparé de la suite.
      const response = text ? (state.response ? `${state.response}\n\n${text}` : text) : state.response;
      return { turns: [...state.turns, turn], response, usage: sum(state.usage, usage) };
    })
    .addNode("tools", async (state, config) => {
      const calls = lastCalls(state.turns);
      const signal = config.signal ?? new AbortController().signal;
      const results = await Promise.all(
        calls.map(async (call, index): Promise<ChatTurn> => {
          if (index >= MAX_TOOL_CALLS_PER_STEP) {
            return { role: "tool", toolCallId: call.id, name: call.name, content: "Trop d'appels simultanés : réessaie avec moins d'outils.", isError: true };
          }
          config.writer?.({ tool: { id: call.id, name: call.name, status: "running" } satisfies ToolEvent });
          const result = await runTool(tools, call, signal);
          config.writer?.({
            tool: { id: call.id, name: call.name, status: result.isError ? "error" : "done", summary: result.summary } satisfies ToolEvent,
          });
          return { role: "tool", toolCallId: call.id, name: call.name, content: result.content, ...(result.isError ? { isError: true } : {}) };
        }),
      );
      return { turns: [...state.turns, ...results], steps: state.steps + 1 };
    })
    .addEdge(START, "model")
    .addConditionalEdges("model", (state) => (lastCalls(state.turns).length > 0 ? "tools" : END), ["tools", END])
    .addEdge("tools", "model")
    .compile();
}

export function createChatRunner(model: ChatModel = echoModel): ChatRunner {
  return async (input, options = {}) => {
    const tools = model.supportsTools ? (input.tools ?? []) : [];
    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    const graph = buildAgentGraph(model, tools, maxSteps);
    const turns: ChatTurn[] = [
      ...(input.history ?? []),
      { role: "user", content: input.message, ...(input.images?.length ? { images: input.images } : {}) },
    ];

    const stream = await graph.stream(
      { turns, instructions: input.instructions, response: "", usage: undefined, steps: 0 },
      {
        streamMode: ["custom", "values"],
        // Chaque étape compte deux nœuds (model + tools), plus la conclusion.
        recursionLimit: 2 * maxSteps + 4,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    let final: { response: string; usage?: TokenUsage | undefined; steps: number } | undefined;
    for await (const [mode, chunk] of stream) {
      if (mode === "custom") {
        const event = chunk as { token?: unknown; tool?: ToolEvent };
        if (typeof event.token === "string") options.onToken?.(event.token);
        if (event.tool) options.onTool?.(event.tool);
      } else {
        final = chunk as typeof final;
      }
    }

    const content = final?.response.trim() ?? "";
    if (!content) throw new Error("EMPTY_MODEL_RESPONSE");

    return {
      content: final!.response,
      model: model.id,
      steps: final!.steps,
      ...(final?.usage ? { usage: final.usage } : {}),
    };
  };
}
