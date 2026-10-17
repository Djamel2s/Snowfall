import { context, SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TokenUsage } from "../graph/chat-graph.js";

// Traces des agents, au standard OpenTelemetry (conventions « GenAI ») :
//
//   invoke_agent            ← une réponse (run, ou reprise d'un run)
//   ├─ chat <modèle>        ← chaque appel au modèle : tokens, cache, durée
//   ├─ execute_tool <nom>   ← chaque outil : statut (fait, refusé, erreur)
//   └─ chat <modèle>
//
// Exportées en OTLP vers Langfuse (auto-hébergé) ; n'importe quel outil
// OpenTelemetry pourrait les recevoir à la place, sans changer ce code.

/** Contenu des traces : masqué (données personnelles retirées) ou aucun (seulement mesures et noms). */
export type TraceContent = "masked" | "none";

const MAX_CONTENT = 4_000;

/**
 * Retire les données personnelles et secrets reconnaissables avant d'envoyer
 * un texte dans les traces. Au mieux : un nom propre dans une phrase passe. D'où
 * le mode « none », et l'absence totale de contenu pour les bases confidentielles.
 */
export function maskPersonalData(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|xox[abp]|ghp|glpat|AKIA)[-_][A-Za-z0-9_-]{8,}\b/g, "[secret]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "Bearer [secret]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "[iban]")
    .replace(/\b[12][ ]?\d{2}[ ]?(?:0[1-9]|1[0-2])[ ]?(?:\d{2}|2[AB])[ ]?\d{3}[ ]?\d{3}(?:[ ]?\d{2})?\b/g, "[nir]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[carte]")
    .replace(/(?:\+\d{1,3}[ .-]?)?(?:\(?0?\d\)?[ .-]?)(?:\d{2}[ .-]?){3}\d{2}\b/g, "[téléphone]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]");
}

const shorten = (text: string) => (text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT)} […]` : text);

export type RunInfo = {
  runId: string;
  conversationId: string;
  userId: string;
  organizationId: string;
  kind: "message" | "regenerate";
  provider: string;
  model: string;
  agent?: { id: string; name: string } | undefined;
  /** Reprise après une validation ou une panne. */
  resumed: boolean;
  /** Conversation sur une base confidentielle : aucun contenu, jamais. */
  confidential: boolean;
  question?: string | undefined;
};

/** Ce que la boucle d'agent signale (voir chat-graph.ts) : aucune dépendance à OpenTelemetry. */
export interface AgentTrace {
  model(info: { step: number }): { end(result: { usage?: TokenUsage | undefined; output?: string; toolCalls?: string[]; error?: unknown }): void };
  tool(info: { name: string; callId: string; input?: unknown }): {
    /** waiting : l'outil attend une validation (le run se met en pause). */
    end(result: { status: "done" | "error" | "denied" | "waiting"; output?: string }): void;
  };
}

export interface RunTrace extends AgentTrace {
  /** interrupted : instance arrêtée ou bail perdu ; le run sera repris ailleurs (nouvelle trace). */
  end(result: { status: "done" | "paused" | "cancelled" | "error" | "interrupted"; output?: string; usage?: TokenUsage | undefined; error?: unknown }): void;
}

export interface RunTracer {
  startRun(info: RunInfo): RunTrace;
  /** Vide les traces en attente (arrêt du serveur). */
  shutdown(): Promise<void>;
}

const noopSpan = { end: () => undefined };
export const noopTracer: RunTracer = {
  startRun: () => ({ model: () => noopSpan, tool: () => noopSpan, end: () => undefined }),
  shutdown: async () => undefined,
};

const usageAttributes = (usage: TokenUsage | undefined): Attributes =>
  usage
    ? {
        "gen_ai.usage.input_tokens": usage.inputTokens,
        "gen_ai.usage.output_tokens": usage.outputTokens,
        "gen_ai.usage.cache_read.input_tokens": usage.cachedInputTokens ?? 0,
      }
    : {};

/** Erreur : son type seulement, jamais son message (il peut contenir des données). */
function fail(span: Span, error: unknown) {
  const type = error instanceof Error ? error.constructor.name : "Error";
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR, message: type });
}

export class OtelRunTracer implements RunTracer {
  private readonly tracer: Tracer;

  constructor(
    private readonly provider: BasicTracerProvider,
    private readonly content: TraceContent,
  ) {
    this.tracer = provider.getTracer("snowfall-agents");
  }

  startRun(info: RunInfo): RunTrace {
    const withContent = this.content === "masked" && !info.confidential;
    const text = (value: string | undefined) => (withContent && value ? shorten(maskPersonalData(value)) : undefined);
    // Repris sur chaque observation : Langfuse filtre et agrège par session et utilisateur.
    const shared: Attributes = {
      "langfuse.session.id": info.conversationId,
      "langfuse.user.id": info.userId,
      "snowfall.run.id": info.runId,
      "snowfall.organization.id": info.organizationId,
    };

    const root = this.tracer.startSpan(`invoke_agent ${info.agent?.name ?? info.model}`, {
      attributes: {
        ...shared,
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": info.provider,
        "gen_ai.request.model": info.model,
        "gen_ai.conversation.id": info.conversationId,
        ...(info.agent ? { "gen_ai.agent.id": info.agent.id, "gen_ai.agent.name": info.agent.name } : {}),
        "langfuse.trace.name": info.kind === "message" ? "réponse" : "régénération",
        "langfuse.trace.tags": [info.kind, info.provider, ...(info.resumed ? ["reprise"] : []), ...(info.confidential ? ["confidentiel"] : [])],
        "snowfall.content": withContent ? "masked" : "none",
        ...(text(info.question) ? { "langfuse.observation.input": text(info.question)! } : {}),
      },
    });
    const parent = trace.setSpan(context.active(), root);

    return {
      model: ({ step }) => {
        const span = this.tracer.startSpan(
          `chat ${info.model}`,
          {
            attributes: {
              ...shared,
              "gen_ai.operation.name": "chat",
              "gen_ai.provider.name": info.provider,
              "gen_ai.request.model": info.model,
              "langfuse.observation.type": "generation",
              "snowfall.step": step,
            },
          },
          parent,
        );
        return {
          end: ({ usage, output, toolCalls, error }) => {
            span.setAttributes(usageAttributes(usage));
            if (toolCalls?.length) span.setAttribute("snowfall.tool_calls", toolCalls);
            if (text(output)) span.setAttribute("langfuse.observation.output", text(output)!);
            if (error) fail(span, error);
            span.end();
          },
        };
      },
      tool: ({ name, callId, input }) => {
        const span = this.tracer.startSpan(
          `execute_tool ${name}`,
          {
            attributes: {
              ...shared,
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": name,
              "gen_ai.tool.call.id": callId,
              "gen_ai.tool.type": "function",
              ...(text(input === undefined ? undefined : JSON.stringify(input)) ? { "gen_ai.tool.call.arguments": text(JSON.stringify(input))! } : {}),
            },
          },
          parent,
        );
        return {
          end: ({ status, output }) => {
            span.setAttribute("snowfall.tool.status", status);
            if (text(output)) span.setAttribute("gen_ai.tool.call.result", text(output)!);
            if (status === "error") span.setStatus({ code: SpanStatusCode.ERROR, message: "tool_error" });
            span.end();
          },
        };
      },
      end: ({ status, output, usage, error }) => {
        root.setAttributes({ ...usageAttributes(usage), "snowfall.status": status });
        if (text(output)) root.setAttribute("langfuse.observation.output", text(output)!);
        if (error) fail(root, error);
        root.end();
      },
    };
  }

  shutdown() {
    return this.provider.shutdown();
  }

  /** Envoie les traces en attente (tests, contrôle). */
  flush() {
    return this.provider.forceFlush();
  }
}

/** Traces vers Langfuse (OTLP/HTTP, authentification Basic avec les clés du projet). */
export function createLangfuseTracer(settings: { baseUrl: string; publicKey: string; secretKey: string; content: TraceContent }, exporter?: SpanExporter) {
  const auth = Buffer.from(`${settings.publicKey}:${settings.secretKey}`).toString("base64");
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "snowfall-api" }),
    spanProcessors: [
      new BatchSpanProcessor(
        exporter ??
          new OTLPTraceExporter({
            url: `${settings.baseUrl}/api/public/otel/v1/traces`,
            headers: { Authorization: `Basic ${auth}`, "x-langfuse-ingestion-version": "4" },
          }),
      ),
    ],
  });
  return new OtelRunTracer(provider, settings.content);
}

/**
 * Conservation limitée (30 jours par défaut). La rétention intégrée de Langfuse
 * est réservée à son édition payante : les traces plus anciennes sont effacées
 * ici, par l'API publique de Langfuse.
 */
export function startTraceRetention(
  settings: { baseUrl: string; publicKey: string; secretKey: string; retentionDays: number },
  log: { info: (data: object, message: string) => void; warn: (data: object, message: string) => void },
  fetcher: typeof fetch = fetch,
) {
  const auth = `Basic ${Buffer.from(`${settings.publicKey}:${settings.secretKey}`).toString("base64")}`;
  const purge = async () => {
    const before = new Date(Date.now() - settings.retentionDays * 86_400_000).toISOString();
    // Effacement asynchrone chez Langfuse : une trace demandée reste listée un
    // moment ; on ne la redemande pas, et on s'arrête quand rien de nouveau n'apparaît.
    const requested = new Set<string>();
    // Langfuse v4 : les traces se listent par leurs observations racines (API v2).
    // Au plus 50 lots par passage ; la suite au passage suivant.
    for (let batch = 0; batch < 50; batch++) {
      const query = new URLSearchParams({
        fromStartTime: "1970-01-01T00:00:00.000Z",
        toStartTime: before,
        isRootObservation: "true",
        fields: "core",
        limit: "500",
      });
      const listed = await fetcher(`${settings.baseUrl}/api/public/v2/observations?${query}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(30_000),
      });
      if (!listed.ok) throw new Error(`LANGFUSE_${listed.status}`);
      const rows = ((await listed.json()) as { data?: { traceId: string }[] }).data ?? [];
      const ids = [...new Set(rows.map((row) => row.traceId))].filter((id) => !requested.has(id));
      if (ids.length === 0) break;
      const removed = await fetcher(`${settings.baseUrl}/api/public/traces`, {
        method: "DELETE",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ traceIds: ids }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!removed.ok) throw new Error(`LANGFUSE_${removed.status}`);
      for (const id of ids) requested.add(id);
    }
    if (requested.size) log.info({ deleted: requested.size, before }, "Traces expirées effacées");
    return requested.size;
  };
  const run = () => void purge().catch((error: unknown) => log.warn({ err: error }, "Purge des traces impossible"));
  const timer = setInterval(run, 6 * 3_600_000);
  timer.unref();
  setTimeout(run, 60_000).unref();
  return { purge, stop: () => clearInterval(timer) };
}
