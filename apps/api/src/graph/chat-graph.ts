import { Annotation, Command, END, Send, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import { runTool, toolSpec, type AgentTool, type Approver, type ToolPreview, type ToolSpec } from "../agent/tools.js";

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
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean; data?: unknown };

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

/** Action d'écriture en attente de validation (pause durable du run). */
export type PendingApproval = { id: string; callId: string; name: string; preview: ToolPreview };

export type ChatResult = {
  content: string;
  model: string;
  usage?: TokenUsage;
  /** Étapes (appels d'outils) effectuées pour produire la réponse. */
  steps?: number;
  /** Run en pause : validations attendues (la réponse n'est pas terminée). */
  pending?: PendingApproval[];
  /** Transcription complète (résultats d'outils compris), pour les sources. */
  turns?: ChatTurn[];
};

/** Événement d'outil diffusé à l'interface pendant l'exécution. */
export type ToolEvent = {
  id: string;
  name: string;
  /** denied : l'utilisateur a refusé (outil d'écriture). */
  status: "running" | "done" | "error" | "denied";
  summary?: string | undefined;
};

/**
 * Exécution durable : l'état du graphe est enregistré après chaque étape
 * (checkpointer), une validation met le run en pause (interrupt) et resume
 * le reprend avec les décisions, par identifiant de demande.
 */
export type DurableOptions = {
  checkpointer: BaseCheckpointSaver;
  /** Identifiant du run (thread LangGraph). */
  threadId: string;
  /** Reprise : décision par demande de validation. Absent : nouveau run. */
  resume?: Record<string, boolean>;
  /** Reprise après une panne : on repart du dernier point de reprise, sans nouvelle entrée. */
  continue?: boolean;
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
  options?: {
    onToken?: (text: string) => void;
    onTool?: (event: ToolEvent) => void;
    /** Validation humaine en mémoire (sans exécution durable). Absente : écritures refusées. */
    approve?: Approver;
    durable?: DurableOptions;
    signal?: AbortSignal;
  },
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
  /**
   * Transcription : historique, message, puis réponses et résultats d'outils.
   * Chaque nœud ajoute ses tours (les appels d'outils parallèles aussi).
   */
  turns: Annotation<ChatTurn[]>({ reducer: (current, added) => current.concat(added), default: () => [] }),
  instructions: Annotation<string | undefined>,
  /** Texte visible produit par le modèle, toutes étapes confondues. */
  response: Annotation<string>,
  usage: Annotation<TokenUsage | undefined>,
  /** Aller-retour modèle → outils déjà demandés. */
  steps: Annotation<number>,
});

type State = typeof AgentState.State;

/** Appels demandés par le dernier tour du modèle (suivi, au plus, de refus immédiats). */
const lastCalls = (turns: ChatTurn[]) => {
  const last = [...turns].reverse().find((turn) => turn.role !== "tool");
  return last?.role === "assistant" ? (last.toolCalls ?? []) : [];
};

/**
 * Boucle d'agent :
 *
 *   START → model ──(appels d'outils ?)──► tool ×N (en parallèle) ──► model … ──► END
 *
 * Le nœud « model » demande une réponse ; chaque appel d'outil devient une
 * tâche « tool » distincte (Send). Avec un checkpointer, le résultat de chaque
 * tâche est enregistré dès qu'il existe : à la reprise (après une validation
 * ou une panne), une tâche terminée n'est JAMAIS relancée, seule celle qui
 * attendait l'est. Au-delà de maxSteps, le modèle est rappelé SANS outils.
 */
export function buildAgentGraph(
  model: ChatModel,
  tools: AgentTool[],
  maxSteps: number,
  options: { approve?: Approver; checkpointer?: BaseCheckpointSaver } = {},
) {
  const specs = tools.map(toolSpec);
  // Exécution durable : la validation est une pause du graphe, enregistrée.
  const approve: Approver | undefined = options.checkpointer
    ? async ({ callId, name, preview }) => interrupt<Omit<PendingApproval, "id">, boolean>({ callId, name, preview }) === true
    : options.approve;

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
      // Au-delà de la limite par étape : refus immédiat, sans tâche.
      const refused: ChatTurn[] = calls.slice(MAX_TOOL_CALLS_PER_STEP).map((call) => ({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: "Trop d'appels simultanés : réessaie avec moins d'outils.",
        isError: true,
      }));
      // Le texte d'une étape d'outil (« Je vais chercher… ») est séparé de la suite.
      const response = text ? (state.response ? `${state.response}\n\n${text}` : text) : state.response;
      return {
        turns: [turn, ...refused],
        response,
        usage: sum(state.usage, usage),
        steps: calls.length ? state.steps + 1 : state.steps,
      };
    })
    .addNode("tool", async (input: { call: ToolCall }, config) => {
      const { call } = input;
      const signal = config.signal ?? new AbortController().signal;
      config.writer?.({ tool: { id: call.id, name: call.name, status: "running" } satisfies ToolEvent });
      const result = await runTool(tools, call, signal, approve);
      const status = result.denied ? "denied" : result.isError ? "error" : "done";
      config.writer?.({ tool: { id: call.id, name: call.name, status, summary: result.summary } satisfies ToolEvent });
      const turn: ChatTurn = {
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
        ...(result.data !== undefined ? { data: result.data } : {}),
      };
      return { turns: [turn] };
    })
    .addEdge(START, "model")
    .addConditionalEdges(
      "model",
      (state: State) => {
        const calls = lastCalls(state.turns).slice(0, MAX_TOOL_CALLS_PER_STEP);
        return calls.length ? calls.map((call) => new Send("tool", { call })) : END;
      },
      ["tool", END],
    )
    .addEdge("tool", "model")
    .compile(options.checkpointer ? { checkpointer: options.checkpointer } : {});
}

export function createChatRunner(model: ChatModel = echoModel): ChatRunner {
  return async (input, options = {}) => {
    const tools = model.supportsTools ? (input.tools ?? []) : [];
    const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
    const durable = options.durable;
    const graph = buildAgentGraph(model, tools, maxSteps, {
      ...(options.approve ? { approve: options.approve } : {}),
      ...(durable ? { checkpointer: durable.checkpointer } : {}),
    });
    const turns: ChatTurn[] = [
      ...(input.history ?? []),
      { role: "user", content: input.message, ...(input.images?.length ? { images: input.images } : {}) },
    ];
    const config = {
      // Chaque étape compte deux super-étapes (model + outils), plus la conclusion.
      recursionLimit: 2 * maxSteps + 4,
      ...(durable ? { configurable: { thread_id: durable.threadId } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const stream = await graph.stream(
      durable?.resume
        ? new Command({ resume: durable.resume })
        : durable?.continue
          ? null
          : { turns, instructions: input.instructions, response: "", usage: undefined, steps: 0 },
      { ...config, streamMode: ["custom", "values"] },
    );

    let final: State | undefined;
    for await (const [mode, chunk] of stream) {
      if (mode === "custom") {
        const event = chunk as { token?: unknown; tool?: ToolEvent };
        if (typeof event.token === "string") options.onToken?.(event.token);
        if (event.tool) options.onTool?.(event.tool);
      } else {
        final = chunk as State;
      }
    }

    // Pause : des tâches attendent une validation (état enregistré).
    if (durable) {
      const snapshot = await graph.getState(config);
      final = snapshot.values as State;
      const waiting = new Set(snapshot.next);
      const pending = snapshot.tasks
        .filter((task) => waiting.has(task.name))
        .flatMap((task) => task.interrupts)
        .filter((item) => item.id)
        .map((item) => ({ id: item.id!, ...(item.value as Omit<PendingApproval, "id">) }));
      if (pending.length) {
        return {
          content: final.response,
          model: model.id,
          steps: final.steps,
          pending,
          turns: final.turns,
          ...(final.usage ? { usage: final.usage } : {}),
        };
      }
    }

    const content = final?.response.trim() ?? "";
    if (!content) throw new Error("EMPTY_MODEL_RESPONSE");

    return {
      content: final!.response,
      model: model.id,
      steps: final!.steps,
      turns: final!.turns,
      ...(final?.usage ? { usage: final.usage } : {}),
    };
  };
}
