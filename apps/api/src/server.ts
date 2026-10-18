import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { PassThrough } from "node:stream";
import { z } from "zod";
import {
  echoModel,
  ModelRefusalError,
  isRateLimit,
  type ChatRunner,
  type ChatTurn,
  type ModelImage,
  type PendingApproval,
  type TokenUsage,
} from "./graph/chat-graph.js";
import {
  ProviderRegistry,
  ProviderUnavailableError,
  type ModelRegistry,
} from "./llm/registry.js";
import { providerIds, type ModelSelection, type ProviderId, type ProviderSettings } from "./llm/types.js";
import { agentProfileSchema, generationOf } from "./agents/profile.js";
import { PostgresAgentStore, type Agent, type AgentStore } from "./agents/store.js";
import databasePlugin from "./plugins/database.js";
import {
  createSessionAuthenticator,
  PostgresIdentityDirectory,
  type AuthenticatedUser,
  type Authenticator,
  type IdentityDirectory,
} from "./auth/auth.js";
import {
  KeycloakOidcClient,
  LoginTransactionCodec,
  type OidcClient,
} from "./auth/oidc.js";
import {
  PostgresSessionStore,
  SESSION_MAX_SECONDS,
  type SessionStore,
} from "./auth/session-store.js";
import {
  FanoutAuditLog,
  HttpAuditForwarder,
  LoggerAuditSink,
  noopAuditLog,
  PostgresAuditLog,
  type AuditLog,
  type AuditSink,
} from "./audit/audit.js";
import { loadConfig } from "./config.js";
import { parseMasterKey } from "./crypto/envelope.js";
import { OrganizationKeyring } from "./crypto/keyring.js";
import { createKeyEncryption } from "./crypto/vault.js";
import { getPool } from "./db/pool.js";
import { findSchemaDrift } from "./db/schema-check.js";
import {
  PostgresConversationStore,
  type ConversationStore,
  type ConversationSummary,
  type MessageSource,
  type StoredMessage,
} from "./conversations/store.js";
import { buildModelInput, estimateTokens } from "./attachments/prompt.js";
import {
  compactionCandidate,
  createSummarizer,
  MemorySummaryStore,
  planContext,
  PostgresSummaryStore,
  type Summarizer,
  type SummaryStore,
} from "./conversations/compaction.js";
import { PostgresAttachmentStore, type AttachmentStore } from "./attachments/store.js";
import { PostgresProjectStore, type ProjectStore } from "./projects/store.js";
import { PostgresMemberStore, provisionIdentity, type MemberStore } from "./workspace/members.js";
import { PostgresPreferencesStore, type PreferencesStore } from "./workspace/preferences.js";
import {
  checkQuota,
  PostgresSettingsStore,
  type SettingsStore,
  type UsageTotals,
} from "./workspace/settings.js";
import { createRouteKit } from "./routes/kit.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { parseImport } from "./conversations/import.js";
import { MemoryPromptStore, PostgresPromptStore, type PromptStore } from "./prompts/store.js";
import { InMemoryUserMemoryStore, PostgresUserMemoryStore, type UserMemoryStore } from "./memory/store.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { memoryTool } from "./agent/memory-tool.js";
import { carriesNotice, guardTools } from "./agent/injection-guard.js";
import { UnixSocketOcr, type DocumentOcr } from "./ocr/client.js";
import { PostgresAgentRatingStore, type AgentRating, type AgentRatingStore } from "./agents/ratings.js";
import { registerPromptRoutes } from "./routes/prompts.js";
import { MemoryShareStore, PostgresShareStore, SHARE_DURATIONS, type ShareStore } from "./shares/store.js";
import { meterOf, MemoryToolUsageStore, type OrganizationSettings, type ToolUsageStore } from "./workspace/settings.js";
import { registerMcpRoutes, type McpDependencies } from "./routes/mcp.js";
import { PostgresMcpServerStore } from "./mcp/store.js";
import { publicAddressOnly } from "./mcp/client.js";
import { mcpToolsFor } from "./mcp/tools.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { EmbeddingRegistry, type EmbeddingConfig, type EmbeddingProvider } from "./knowledge/embeddings.js";
import { citationsOf, KnowledgeService, renderKnowledge, type ActiveBase, type Passage } from "./knowledge/service.js";
import { PostgresKnowledgeStore } from "./knowledge/store.js";
import { createQueryRewriter, heuristicStandalone, type QueryRewriter } from "./knowledge/rewrite.js";
import { HttpReranker } from "./knowledge/rerank.js";
import { CitationRegistry, knowledgeTool } from "./agent/knowledge-tool.js";
import { knowledgeWriteTool } from "./agent/knowledge-write-tool.js";
import { webTools, WebSession } from "./agent/web-tools.js";
import { codeTool, generatedFileIds, UnixSocketSandbox, type CodeSandbox } from "./agent/code-tool.js";
import { MemoryGeneratedFileStore, PostgresGeneratedFileStore, type GeneratedFileStore } from "./files/generated.js";
import { SearxngClient, type WebSearchEngine } from "./web/searxng.js";
import { EncryptedCheckpointSaver } from "./agent/checkpointer.js";
import {
  MemoryRunStore,
  PostgresRunStore,
  RunEvents,
  type RunEvent,
  type RunProgress,
  type RunRecord,
  type RunRequest,
  type RunStore,
} from "./agent/runs.js";
import { defaultOrganizationTools, permittedTools, platformDependentTools, toolIds, type ToolId } from "./agent/catalog.js";
import type { AgentTool } from "./agent/tools.js";
import { ClamdScanner, type MalwareScanner } from "./security/antivirus.js";
import { countingAuditLog, createMetrics, startMetricsServer, type Metrics } from "./observability/metrics.js";
import { createLangfuseTracer, noopTracer, startTraceRetention, type RunTrace, type RunTracer } from "./observability/tracing.js";

dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

declare module "fastify" {
  interface FastifyContextConfig {
    /** Route accessible sans session. Tout le reste est refusé par défaut. */
    public?: boolean;
    /**
     * Route appelée par un serveur (Keycloak, navigateur pour les rapports CSP)
     * et authentifiée autrement que par la session : pas de contrôle Origin.
     */
    csrfExempt?: boolean;
  }
  interface FastifyRequest {
    principal: AuthenticatedUser | null;
  }
}

export type ProvisionInput = {
  issuer: string;
  subject: string;
  email?: string | undefined;
  emailVerified: boolean;
  ssoAliases: string[];
};

export type LoginFlow = {
  issuer: string;
  oidc: OidcClient;
  sessions: SessionStore;
  directory: IdentityDirectory;
  transactions: LoginTransactionCodec;
  /** Rattachement à la connexion (invitation, SSO d'organisation). */
  provision?: (input: ProvisionInput) => Promise<{ userId: string | null; joined: number }>;
};

export type AppDependencies = {
  appOrigin?: string;
  cookieSecure?: boolean;
  trustProxy?: boolean | string;
  redis?: Redis;
  withDatabase?: boolean;
  logger?: boolean;
  authenticate?: Authenticator;
  conversationStore: ConversationStore;
  audit?: AuditLog;
  login?: LoginFlow;
  /** Fournisseurs LLM configurés et catalogue de modèles. */
  models?: ModelRegistry;
  agents?: AgentStore;
  settings?: SettingsStore;
  members?: MemberStore;
  preferences?: PreferencesStore;
  projects?: ProjectStore;
  attachments?: AttachmentStore;
  /** Bases de connaissances (agents et projets). */
  knowledge?: KnowledgeService;
  /** Fournisseurs configurés pour les embeddings. */
  embeddingProviders?: () => EmbeddingProvider[];
  /** Antivirus des fichiers reçus (pièces jointes, bases de connaissances). */
  scanner?: MalwareScanner;
  /** Métriques Prometheus (exposées sur un port interne dédié). */
  metrics?: Metrics;
  /** Reformulation des questions de suivi pour la recherche (sinon : repli simple). */
  rewriteQuery?: QueryRewriter;
  /** Boucle d'agent : aller-retour modèle ↔ outils au maximum par réponse. */
  agentMaxSteps?: number;
  /** Budget de tokens d'une réponse (toutes étapes) ; au-delà, plus d'outils. */
  agentMaxTokens?: number;
  /** Appels d'outils du mois (quotas des outils). Absent : en mémoire. */
  toolUsage?: ToolUsageStore;
  /** Runs d'agent (exécution durable). Absent : en mémoire (développement, tests). */
  runs?: RunStore;
  /** Points de reprise du graphe, par propriétaire. Absent : en mémoire. */
  checkpointer?: (tenant: { organizationId: string; userId: string }) => BaseCheckpointSaver;
  /** Moteur de recherche web (SearXNG). Absent : outil web_search indisponible. */
  webSearch?: WebSearchEngine;
  /** Bac à sable d'exécution de code. Absent : interpréteur indisponible. */
  sandbox?: CodeSandbox;
  /** Serveurs MCP approuvés par l'admin. Absent : outil « mcp » indisponible. */
  mcp?: McpDependencies;
  /** Fichiers produits par le code. Absent : en mémoire. */
  generatedFiles?: GeneratedFileStore;
  /** Liens de partage internes. Absent : en mémoire. */
  shares?: ShareStore;
  /** Bibliothèque de prompts. Absent : en mémoire. */
  prompts?: PromptStore;
  /** Mémoire des utilisateurs (utilisée seulement s'ils l'ont activée). */
  memories?: UserMemoryStore;
  /** OCR local des documents numérisés (absent : non lus). */
  ocr?: DocumentOcr;
  /** Taux de réponses utiles par agent (agrégat de l'organisation). */
  agentRatings?: AgentRatingStore;
  /** Traces des agents (OpenTelemetry → Langfuse). Absent : aucune trace. */
  tracer?: RunTracer;
  /** Résumés de compaction des longues conversations. Absent : en mémoire. */
  summaries?: SummaryStore;
  /** Résumeur (compaction). Absent : pas de compaction, historique tronqué au budget. */
  summarize?: Summarizer;
  /** Durées des runs (tests : quelques millisecondes pour simuler une panne). */
  runTiming?: Partial<typeof RUN_TIMING>;
  /** Remplace le routage par modèle (tests). */
  runChat?: ChatRunner;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const RUN_TIMING = {
  /** Bail d'exécution : renouvelé toutes les 10 s, repris par une autre instance après 30 s. */
  leaseMs: 30_000,
  renewMs: 10_000,
  /** Recherche des runs orphelins. */
  recoveryMs: 30_000,
  /** Validation sans réponse au-delà : refusée. */
  approvalTtlSeconds: 24 * 60 * 60,
  /** Durée d'exécution active d'un passage (hors pauses) : au-delà, la réponse s'arrête, le partiel est gardé. */
  maxActiveMs: 10 * 60 * 1000,
};

/** Entrée du modèle au lancement d'un run (le résumé de compaction part dans le prompt système). */
type RunInput = { history: ChatTurn[]; message: string; images: ModelImage[]; summary?: string | undefined };

/** Ajouté à une réponse coupée par la durée maximale. */
const LIMIT_NOTICE = "Réponse interrompue : durée maximale d'une réponse atteinte.";

/** Échec attendu d'un run (conversation supprimée, modèle retiré…) : message transmis tel quel. */
class RunFailure extends Error {}
const HISTORY_TURNS = 20;

/**
 * Connaissances d'une réponse : aucune, injectées d'office (modèle sans
 * outils), ou outil de recherche confié à l'agent (RAG agentique).
 */
type KnowledgePlan =
  | { mode: "none" }
  | { mode: "inline"; passages: Passage[] }
  | { mode: "agent"; tools: AgentTool[]; citations: CitationRegistry };

export function cookieNames(secure: boolean) {
  // Le préfixe __Host- impose Secure, Path=/ et l'absence de Domain.
  const prefix = secure ? "__Host-" : "";
  return {
    session: `${prefix}snowfall_session`,
    login: `${prefix}snowfall_login`,
  };
}

/** Origine seule d'une URL signalée (jamais le chemin ni la requête). */
function originOf(value: unknown) {
  if (typeof value !== "string") return "";
  if (["inline", "eval", "self", "data", "blob"].includes(value)) return value;
  try {
    return new URL(value).origin.slice(0, 200);
  } catch {
    return value.slice(0, 40);
  }
}

export function createAppServer(deps: AppDependencies) {
  const appOrigin = deps.appOrigin ?? "http://localhost:5173";
  const cookieSecure = deps.cookieSecure ?? false;
  const cookies = cookieNames(cookieSecure);
  const audit = deps.audit ?? noopAuditLog;
  const kit = createRouteKit(audit);
  const authenticate: Authenticator = deps.authenticate ?? (async () => null);
  const conversationStore = deps.conversationStore;
  const models = deps.models ?? new ProviderRegistry({}, { fallback: echoModel });
  const agents = deps.agents;
  // Exécution durable : runs, points de reprise, diffusion aux connexions de cette instance.
  const runs = deps.runs ?? new MemoryRunStore();
  const memoryCheckpoints = new MemorySaver();
  const checkpointerFor = deps.checkpointer ?? (() => memoryCheckpoints);
  const runEvents = new RunEvents();
  const summaries = deps.summaries ?? new MemorySummaryStore();
  const tracer = deps.tracer ?? noopTracer;
  const generatedFiles = deps.generatedFiles ?? new MemoryGeneratedFileStore();
  const toolUsage = deps.toolUsage ?? new MemoryToolUsageStore();
  const shares = deps.shares ?? new MemoryShareStore();
  const prompts = deps.prompts ?? new MemoryPromptStore();
  const memories = deps.memories ?? new InMemoryUserMemoryStore();
  /** Identifiant de cette instance (bail des runs qu'elle exécute). */
  const instance = `api-${randomUUID()}`;
  const localRuns = new Map<string, { stop: (reason: "cancel" | "lost" | "shutdown") => void }>();
  /** Flux SSE ouverts sur cette instance (fermés à l'arrêt). */
  const observers = new Set<() => void>();
  const timing = { ...RUN_TIMING, ...deps.runTiming };
  const RUN_LEASE_MS = timing.leaseMs;
  const RUN_RENEW_MS = timing.renewMs;
  const RUN_RECOVERY_MS = timing.recoveryMs;
  const RUN_APPROVAL_TTL_S = timing.approvalTtlSeconds;
  const runnerFor = (selection?: ModelSelection) =>
    deps.runChat ?? models.runner(selection);

  const app = Fastify({
    logger: (deps.logger ?? process.env.NODE_ENV !== "test")
      ? {
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              'res.headers["set-cookie"]',
            ],
            censor: "[redacted]",
          },
          serializers: {
            // Jamais de query string dans les logs : elle peut porter des
            // secrets (code d'autorisation OIDC, state…).
            req: (request) => ({
              method: request.method,
              url: request.url.split("?")[0] ?? "",
              remoteAddress: request.ip,
            }),
          },
        }
      : false,
    bodyLimit: 1_048_576,
    trustProxy: deps.trustProxy ?? false,
  });

  app.decorateRequest("principal", null);

  // Durée et statut par modèle de route (« /conversations/:id »), jamais l'URL.
  if (deps.metrics) {
    const histogram = deps.metrics.http;
    app.addHook("onResponse", async (request, reply) => {
      histogram.observe(
        { method: request.method, route: request.routeOptions.url ?? "unmatched", status: String(reply.statusCode) },
        reply.elapsedTime / 1000,
      );
    });
  }

  app.register(helmet);
  app.register(cookie);
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    ...(deps.redis ? { redis: deps.redis, nameSpace: "snowfall-rl:" } : {}),
  });

  if (deps.withDatabase) {
    app.register(databasePlugin);
  }

  const conversationIdSchema = z.uuid();
  const modelSelectionSchema = z.object({
    provider: z.enum(providerIds),
    model: z.string().min(1).max(120),
  }).strict();

  const createConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    agentId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    model: modelSelectionSchema.optional(),
    temporary: z.boolean().optional(),
  }).strict().refine((body) => !(body.agentId && body.model) && !(body.temporary && body.projectId));

  // agentId / model : qui répond. Les deux à null = modèle par défaut.
  const updateConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    projectId: z.uuid().nullable().optional(),
    agentId: z.uuid().nullable().optional(),
    model: modelSelectionSchema.nullable().optional(),
    // Bases de connaissances consultées (agent, projet), modifiables à tout moment.
    knowledge: z.object({ agent: z.boolean().optional(), project: z.boolean().optional() }).strict().optional(),
  }).strict()
    .refine((body) => Object.values(body).some((value) => value !== undefined))
    .refine((body) => !(body.agentId && body.model));

  const agentInputSchema = agentProfileSchema.extend({
    provider: z.enum(providerIds),
    model: z.string().min(1).max(120),
  });

  const messageSchema = z.object({
    content: z.string().trim().max(4000),
    attachmentIds: z.array(z.uuid()).max(10).default([]),
    /** Modification d'un message : lui et la suite sont remplacés. */
    editMessageId: z.uuid().optional(),
  }).strict().refine((body) => body.content.length > 0 || body.attachmentIds.length > 0);

  // Agent partagé dans l'organisation : modifiable par son auteur ou un admin.
  function canManageAgent(user: AuthenticatedUser, agent: Agent) {
    return agent.createdBy === user.userId || kit.isAdmin(user);
  }

  async function conversationNotFound(
    request: FastifyRequest,
    reply: FastifyReply,
    user: AuthenticatedUser,
    conversationId: string,
  ) {
    // Inexistante OU appartenant à un autre utilisateur/tenant : même réponse,
    // mais tracée pour détecter les tentatives d'accès croisé.
    await audit.record(request, {
      eventType: "conversation.access",
      outcome: "denied",
      actorUserId: user.userId,
      organizationId: user.organizationId,
      targetType: "conversation",
      targetId: conversationId,
    });
    return reply.code(404).send({ error: "Not found" });
  }

  async function allowedProviders(user: AuthenticatedUser): Promise<ProviderId[]> {
    return deps.settings ? (await deps.settings.get(user)).allowedProviders : [...providerIds];
  }

  /** Liste blanche : modèle publié par un fournisseur configuré et autorisé par l'organisation. */
  async function isModelPermitted(user: AuthenticatedUser, selection: ModelSelection) {
    const [published, permitted] = await Promise.all([models.isAllowed(selection), allowedProviders(user)]);
    return published && permitted.includes(selection.provider);
  }

  /** Modèle qui répond : celui de l'agent, sinon celui choisi, sinon le défaut. */
  function selectionFor(conversation: ConversationSummary, agent: Agent | null): ModelSelection | undefined {
    if (agent) return { provider: agent.provider, model: agent.model };
    return conversation.model ?? undefined;
  }

  /**
   * Contrôle avant génération : fournisseur autorisé par l'organisation et
   * plafonds de tokens. Répond directement en cas de refus.
   */
  async function admitGeneration(
    request: FastifyRequest,
    reply: FastifyReply,
    user: AuthenticatedUser,
    selection: ModelSelection | undefined,
  ): Promise<{ provider: ProviderId | "echo" } | null> {
    const provider = models.providerFor(selection);
    if (!deps.settings) return { provider };

    const [settings, usage] = await Promise.all([deps.settings.get(user), deps.settings.usage(user)]);
    const decision = checkQuota(settings, usage, provider);
    if (decision.allowed) return { provider };

    await kit.record(request, user, {
      eventType: "quota.denied",
      outcome: "denied",
      details: { provider, reason: decision.reason },
    });
    const forbidden = decision.reason === "provider_not_allowed";
    await reply.code(forbidden ? 403 : 429).send({
      error: forbidden ? "Provider not allowed" : "Quota exceeded",
      reason: decision.reason,
    });
    return null;
  }

  async function modelFiles(user: AuthenticatedUser, conversationId: string, prior: StoredMessage[], current: string[]) {
    if (!deps.attachments) return new Map();
    const ids = [...current, ...prior.flatMap((message) => message.attachments?.map((file) => file.id) ?? [])];
    return deps.attachments.forModel(user, conversationId, ids);
  }


  app.register(async (api) => {
    // Corps "application/x-www-form-urlencoded" : utilisé par Keycloak pour
    // le logout_token (back-channel), taille bornée.
    api.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16_384 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    // Fichiers envoyés tels quels (pas de multipart). Taille bornée dès la
    // lecture par la limite de chaque route (1 Mo par défaut).
    api.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    // Rapports de violation CSP envoyés par les navigateurs.
    api.addContentTypeParser(
      ["application/csp-report", "application/reports+json"],
      { parseAs: "string", bodyLimit: 16_384 },
      (_request, body, done) => {
        try {
          done(null, JSON.parse(String(body)));
        } catch {
          done(null, null);
        }
      },
    );

    // Protection CSRF : toute requête modifiante doit venir de notre origine.
    // Complète SameSite=Strict sur le cookie de session.
    api.addHook("onRequest", async (request, reply) => {
      if (SAFE_METHODS.has(request.method) || request.routeOptions.config.csrfExempt) return;

      if (request.headers.origin !== appOrigin) {
        await audit.record(request, {
          eventType: "security.csrf_rejected",
          outcome: "denied",
          details: { method: request.method, route: request.routeOptions.url ?? "" },
        });
        return reply.code(403).send({ error: "Forbidden" });
      }
    });

    // Refus par défaut : seules les routes marquées public échappent à l'auth.
    api.addHook("onRequest", async (request, reply) => {
      if (request.routeOptions.config.public) return;

      const user = await authenticate(request);
      if (!user) return reply.code(401).send({ error: "Unauthorized" });

      request.principal = user;
    });

    api.get("/health", { config: { public: true } }, async () => {
      return { status: "ok" };
    });

    api.post(
      "/security/csp-report",
      { config: { public: true, csrfExempt: true, rateLimit: { max: 30, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const body = request.body as Record<string, unknown> | unknown[] | null;
        const reports = Array.isArray(body)
          ? body.map((entry) => (entry as { body?: Record<string, unknown> }).body ?? {})
          : [((body as Record<string, unknown> | null)?.["csp-report"] ?? {}) as Record<string, unknown>];

        for (const report of reports.slice(0, 5)) {
          await audit.record(request, {
            eventType: "security.csp_violation",
            outcome: "denied",
            details: {
              directive: String(report["effectiveDirective"] ?? report["violated-directive"] ?? "").slice(0, 80),
              blocked: originOf(report["blockedURL"] ?? report["blocked-uri"]),
            },
          });
        }
        return reply.code(204).send();
      },
    );

    if (deps.login) {
      registerLoginRoutes(api, deps.login);
    }

    api.get("/auth/me", async (request, reply) => {
      kit.privateResponse(reply);
      const { profile, ...user } = kit.principal(request);
      return {
        user,
        profile: profile ?? {},
        ...(deps.login ? { accountUrl: `${deps.login.issuer}/account` } : {}),
      };
    });

    api.get("/conversations", async (request, reply) => {
      kit.privateResponse(reply);
      return conversationStore.list(kit.principal(request));
    });

    const checkSearchLimit = api.createRateLimit({
      max: 30,
      timeWindow: "1 minute",
      keyGenerator: (request) => `user-search:${kit.principal(request).userId}`,
    });

    api.get("/conversations/search", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      const limit = await checkSearchLimit(request);
      if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });

      const query = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "Invalid request" });
      return { results: await conversationStore.search(user, query.data.q) };
    });

    api.post("/conversations", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const parsed = createConversationSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request" });
      }
      if (parsed.data.model && !(await isModelPermitted(user, parsed.data.model))) {
        return reply.code(400).send({ error: "Invalid request" });
      }

      try {
        const conversation = await conversationStore.create(
          user,
          parsed.data.title,
          parsed.data.agentId,
          parsed.data.projectId,
          parsed.data.model,
          { temporary: parsed.data.temporary === true },
        );
        await kit.record(request, user, {
          eventType: "conversation.create",
          targetType: "conversation",
          targetId: conversation.id,
          ...(conversation.temporary ? { details: { temporary: true } } : {}),
        });
        return reply.code(201).send({ conversation });
      } catch (error) {
        if (error instanceof Error && error.message === "MEMBERSHIP_REQUIRED") {
          return reply.code(403).send({ error: "Forbidden" });
        }
        if (error instanceof Error && ["AGENT_NOT_FOUND", "PROJECT_NOT_FOUND"].includes(error.message)) {
          return reply.code(400).send({ error: "Invalid request" });
        }
        throw error;
      }
    });

    api.patch("/conversations/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      const body = updateConversationSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });

      const { title, projectId, agentId, model, knowledge: knowledgeToggles } = body.data;
      const reselect = agentId !== undefined || model !== undefined;
      if (model && !(await isModelPermitted(user, model))) {
        return reply.code(400).send({ error: "Invalid request" });
      }
      if (agentId && (!agents || !(await agents.get(user, agentId)))) {
        return reply.code(400).send({ error: "Invalid request" });
      }

      try {
        const conversation = await conversationStore.update(user, params.data.id, {
          ...(title !== undefined ? { title } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(reselect ? { selection: { agentId: agentId ?? null, model: model ?? null } } : {}),
          ...(knowledgeToggles
            ? {
                knowledge: {
                  ...(knowledgeToggles.agent !== undefined ? { agent: knowledgeToggles.agent } : {}),
                  ...(knowledgeToggles.project !== undefined ? { project: knowledgeToggles.project } : {}),
                },
              }
            : {}),
        });
        if (!conversation) return conversationNotFound(request, reply, user, params.data.id);

        await kit.record(request, user, {
          eventType: "conversation.update",
          targetType: "conversation",
          targetId: conversation.id,
          details: {
            renamed: title !== undefined,
            moved: projectId !== undefined,
            ...(knowledgeToggles
              ? { agentKnowledge: conversation.knowledge.agent, projectKnowledge: conversation.knowledge.project }
              : {}),
            ...(reselect
              ? {
                  agentId: conversation.agentId ?? "",
                  model: conversation.model ? `${conversation.model.provider}:${conversation.model.model}` : "",
                }
              : {}),
          },
        });
        return { conversation };
      } catch (error) {
        if (error instanceof Error && ["PROJECT_NOT_FOUND", "AGENT_NOT_FOUND"].includes(error.message)) {
          return reply.code(400).send({ error: "Invalid request" });
        }
        // Une conversation commencée garde son agent ou son modèle.
        if (error instanceof Error && error.message === "CONVERSATION_STARTED") {
          return reply.code(409).send({ error: "Conversation already started" });
        }
        throw error;
      }
    });

    api.get("/models", async (request, reply) => {
      kit.privateResponse(reply);
      const [catalog, allowed] = await Promise.all([models.catalog(), allowedProviders(kit.principal(request))]);
      return {
        providers: catalog.map((provider) => ({ ...provider, allowed: allowed.includes(provider.id) })),
        // Modèle des conversations sans agent ni modèle choisi (null : modèle local de développement).
        defaultModel: models.defaultSelection?.() ?? null,
      };
    });

    if (agents) registerAgentRoutes(api, agents);

    registerWorkspaceRoutes(api, kit, {
      settings: deps.settings,
      members: deps.members,
      preferences: deps.preferences,
      projects: deps.projects,
      toolUsage,
      configuredProviders: async () =>
        (await models.catalog()).filter((provider) => provider.available).map((provider) => provider.id),
      ...(deps.embeddingProviders ? { embeddingProviders: deps.embeddingProviders } : {}),
      // Outils dont le service n'est pas installé : ni activables, ni proposés.
      platformTools: () =>
        toolIds.filter(
          (id) =>
            !platformDependentTools.includes(id) ||
            (id === "web_search" && deps.webSearch !== undefined) ||
            (id === "code_interpreter" && deps.sandbox !== undefined) ||
            (id === "mcp" && deps.mcp !== undefined),
        ),
    });
    if (deps.mcp) registerMcpRoutes(api, kit, deps.mcp);
    registerPromptRoutes(api, kit, prompts);
    registerMemoryRoutes(api, kit, memories);

    if (deps.attachments) registerAttachmentRoutes(api, kit, deps.attachments, deps.scanner, deps.ocr);
    if (deps.knowledge) {
      registerKnowledgeRoutes(api, kit, { knowledge: deps.knowledge, agents, canManageAgent, scanner: deps.scanner });
    }

    api.get("/conversations/:id/messages", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const messages = await conversationStore.getMessages(user, params.data.id);
      if (messages === null) {
        return conversationNotFound(request, reply, user, params.data.id);
      }

      return { messages };
    });

    // Retour 👍👎 sur une réponse : enregistré (commentaire chiffré), tracé dans
    // l'audit (note seule), et noté sur la trace de la réponse (note seule).
    api.put("/conversations/:id/messages/:messageId/feedback", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = z.object({ id: conversationIdSchema, messageId: z.uuid() }).safeParse(request.params);
      const body = z
        .object({ rating: z.enum(["up", "down"]).nullable(), comment: z.string().trim().max(1_000).optional() })
        .strict()
        .safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });

      const feedback = body.data.rating ? { rating: body.data.rating, ...(body.data.comment ? { comment: body.data.comment } : {}) } : null;
      const saved = await conversationStore.setFeedback(user, params.data.id, params.data.messageId, feedback);
      if (!saved) return conversationNotFound(request, reply, user, params.data.id);

      await kit.record(request, user, {
        eventType: "message.feedback",
        targetType: "conversation",
        targetId: params.data.id,
        details: { rating: body.data.rating ?? "none", comment: Boolean(feedback?.comment) },
      });
      if (saved.runId && tracer.score) {
        const value = body.data.rating === "up" ? 1 : body.data.rating === "down" ? 0 : null;
        void tracer.score(saved.runId, `feedback-${params.data.messageId}`, value).catch((error: unknown) => request.log.warn({ err: error }, "Note de trace impossible"));
      }
      return { feedback };
    });

    // Branches : afficher une autre version d'un tour (modification, régénération).
    api.post("/conversations/:id/branch", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      const body = z.object({ messageId: z.uuid() }).strict().safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
      // Pendant une réponse, la branche ne change pas sous ses pieds.
      if (await runs.active(user, params.data.id)) return reply.code(409).send({ error: "Run in progress" });

      if (!(await conversationStore.selectBranch(user, params.data.id, body.data.messageId))) {
        return conversationNotFound(request, reply, user, params.data.id);
      }
      return { messages: await conversationStore.getMessages(user, params.data.id) };
    });

    api.delete("/conversations/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const deleted = await conversationStore.delete(user, params.data.id);
      if (!deleted) return conversationNotFound(request, reply, user, params.data.id);

      await kit.record(request, user, {
        eventType: "conversation.delete",
        targetType: "conversation",
        targetId: params.data.id,
      });
      return reply.code(204).send();
    });

    // Limite par utilisateur authentifié (en plus de la limite par IP), pour
    // qu'un compte ne puisse pas épuiser le budget LLM en changeant d'IP.
    const checkUserMessageLimit = api.createRateLimit({
      max: 20,
      timeWindow: "1 minute",
      keyGenerator: (request) => `user-messages:${kit.principal(request).userId}`,
    });

    async function messageLimit(request: FastifyRequest, reply: FastifyReply) {
      const limit = await checkUserMessageLimit(request);
      if (!limit.isAllowed && limit.isExceeded) {
        reply.header("Retry-After", Math.ceil(limit.ttl / 1000));
        await reply.code(429).send({ error: "Too many requests" });
        return false;
      }
      return true;
    }

    async function loadConversation(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser, id: string) {
      const conversation = await conversationStore.get(user, id);
      const history = conversation ? await conversationStore.getMessages(user, id) : null;
      if (!conversation || history === null) {
        await conversationNotFound(request, reply, user, id);
        return null;
      }
      // Agent supprimé entre-temps : repli sur le modèle par défaut.
      const agent = conversation.agentId && agents ? await agents.get(user, conversation.agentId) : null;
      return { conversation, history, agent, selection: selectionFor(conversation, agent) };
    }

    /** Bases de connaissances actives : celle de l'agent et/ou celle du projet. */
    async function activeBases(user: AuthenticatedUser, conversation: ConversationSummary, agent: Agent | null) {
      if (!deps.knowledge) return [];
      const bases: ActiveBase[] = [];
      if (agent && conversation.knowledge.agent) {
        const base = await deps.knowledge.store.findBase(user, { kind: "agent", agentId: agent.id });
        if (base) bases.push({ ...base, label: "agent" });
      }
      if (conversation.projectId && conversation.knowledge.project) {
        const base = await deps.knowledge.store.findBase(user, { kind: "project", projectId: conversation.projectId });
        if (base) bases.push({ ...base, label: "project" });
      }
      return bases;
    }

    /**
     * Passages pertinents pour la question. Une base confidentielle n'est
     * jamais transmise à un modèle hors de la plateforme : la génération est
     * refusée (réponse envoyée ici) plutôt que de faire sortir ses extraits.
     */
    async function retrieveKnowledge(
      request: FastifyRequest,
      reply: FastifyReply,
      user: AuthenticatedUser,
      loaded: { conversation: ConversationSummary; agent: Agent | null; selection: ModelSelection | undefined },
      provider: ProviderId | "echo",
      query: { message: string; history: StoredMessage[] },
      permitted: Set<ToolId>,
    ): Promise<KnowledgePlan | null> {
      const bases = await activeBases(user, loaded.conversation, loaded.agent);
      if (bases.length === 0) return { mode: "none" };
      if (bases.some((base) => base.confidential) && provider !== "local" && provider !== "echo") {
        await kit.record(request, user, {
          eventType: "knowledge.confidential_denied",
          outcome: "denied",
          targetType: "conversation",
          targetId: loaded.conversation.id,
          details: { provider },
        });
        await reply.code(409).send({ error: "Local model required", reason: "confidential_requires_local" });
        return null;
      }
      // RAG agentique : le modèle sait appeler des outils, il cherche lui-même
      // (quand il le juge utile, avec ses propres requêtes, plusieurs fois si besoin).
      // Outil désactivé par l'organisation ou l'agent : injection d'office, comme avant.
      if (models.supportsTools?.(loaded.selection) && permitted.has("search_knowledge")) {
        const citations = new CitationRegistry();
        return { mode: "agent", citations, tools: [knowledgeTool(deps.knowledge!, user, bases, citations)] };
      }
      if (!query.message.trim()) return { mode: "none" };
      try {
        const turns: ChatTurn[] = query.history.slice(-HISTORY_TURNS).map((turn) => ({ role: turn.role, content: turn.content }));
        const standalone = turns.length ? await standaloneQuery(request, user, loaded.selection, provider, turns, query.message) : null;
        return { mode: "inline", passages: await deps.knowledge!.retrieve(user, bases, { text: query.message, standalone }) };
      } catch (error) {
        // Base momentanément indisponible : la réponse se fait sans elle.
        request.log.error({ err: error }, "Recherche dans la base de connaissances impossible");
        return { mode: "none" };
      }
    }

    // ---- Mes données (RGPD : droit d'accès et portabilité) ----------------------
    // Tout ce que la plateforme conserve sur l'utilisateur, déchiffré, en JSON.
    const checkExportLimit = api.createRateLimit({ max: 3, timeWindow: "1 minute", keyGenerator: (request) => `export:${kit.principal(request).userId}` });
    api.get("/me/export", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const limit = await checkExportLimit(request);
      if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });

      const conversations = [];
      for (const conversation of await conversationStore.list(user)) {
        const messages = (await conversationStore.getMessages(user, conversation.id)) ?? [];
        conversations.push({
          id: conversation.id,
          title: conversation.title,
          createdAt: conversation.createdAt,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            ...(message.sources?.length ? { sources: message.sources.map((source) => ({ n: source.n, name: source.name })) } : {}),
            ...(message.attachments?.length ? { attachments: message.attachments.map((file) => file.name) } : {}),
            ...(message.feedback ? { feedback: message.feedback } : {}),
          })),
        });
      }
      const myAgents = agents ? (await agents.list(user)).filter((agent) => agent.createdBy === user.userId) : [];
      const extra = await personalData(user);
      await kit.record(request, user, { eventType: "privacy.export", targetType: "user", targetId: user.userId, details: { conversations: conversations.length } });
      reply.header("Content-Disposition", 'attachment; filename="mes-donnees-snowfall.json"');
      return {
        format: "snowfall.personal-data",
        version: 1,
        exportedAt: new Date().toISOString(),
        account: { userId: user.userId, organizationId: user.organizationId, role: user.role },
        preferences: deps.preferences ? await deps.preferences.get(user) : null,
        conversations,
        agents: myAgents.map((agent) => ({ name: agent.name, instructions: agent.instructions, provider: agent.provider, model: agent.model, tools: agent.tools, createdAt: agent.createdAt })),
        ...extra,
      };
    });

    // ---- Import de conversations (ChatGPT, LibreChat, Snowfall) ----------------
    const checkImportLimit = api.createRateLimit({ max: 5, timeWindow: "1 minute", keyGenerator: (request) => `import:${kit.principal(request).userId}` });
    api.post("/conversations/import", { bodyLimit: 25 * 1024 * 1024 }, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
      const limit = await checkImportLimit(request);
      if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });

      const parsed = parseImport(request.body);
      if (!parsed) return reply.code(400).send({ error: "Invalid request", reason: "unknown_format" });
      let messages = 0;
      for (const conversation of parsed.conversations) {
        await conversationStore.importConversation(user, conversation.title, conversation.messages);
        messages += conversation.messages.length;
      }
      await kit.record(request, user, {
        eventType: "conversation.import",
        targetType: "user",
        targetId: user.userId,
        details: { format: parsed.format, conversations: parsed.conversations.length, messages, skipped: parsed.skipped },
      });
      return reply.code(201).send({ imported: parsed.conversations.length, skipped: parsed.skipped, format: parsed.format });
    });

    // ---- Partage interne ----------------------------------------------------
    // Un lien fige la branche affichée ; lisible par les membres de l'organisation
    // jusqu'à son expiration. Jamais pour une conversation sur une base confidentielle.

    api.post("/conversations/:id/shares", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      const body = z.object({ days: z.number().int().refine((days) => (SHARE_DURATIONS as readonly number[]).includes(days)) }).strict().safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });

      const loaded = await loadConversation(request, reply, user, params.data.id);
      if (!loaded) return reply;
      // Une conversation temporaire ne survit pas à 24 h : elle ne se partage pas.
      if (loaded.conversation.temporary) {
        await kit.record(request, user, { eventType: "share.denied", outcome: "denied", targetType: "conversation", targetId: params.data.id, details: { reason: "temporary" } });
        return reply.code(409).send({ error: "Conflict", reason: "temporary" });
      }
      if ((await activeBases(user, loaded.conversation, loaded.agent)).some((base) => base.confidential)) {
        await kit.record(request, user, { eventType: "share.denied", outcome: "denied", targetType: "conversation", targetId: params.data.id, details: { reason: "confidential" } });
        return reply.code(409).send({ error: "Conflict", reason: "confidential" });
      }
      if (loaded.history.length === 0) return reply.code(400).send({ error: "Invalid request", reason: "empty" });

      // Instantané minimal : texte des messages, nom des sources (pas leurs extraits :
      // une base de projet est privée), ni pièces jointes ni fichiers produits.
      const share = await shares.create(user, {
        conversationId: params.data.id,
        title: loaded.conversation.title,
        days: body.data.days,
        snapshot: {
          ...(loaded.agent ? { agent: { name: loaded.agent.name, avatar: loaded.agent.avatar } } : {}),
          messages: loaded.history.map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            ...(message.sources?.length ? { sources: message.sources.map((source) => ({ n: source.n, name: source.name })) } : {}),
          })),
        },
      });
      await kit.record(request, user, {
        eventType: "share.create",
        targetType: "share",
        targetId: share.id,
        details: { conversationId: params.data.id, days: body.data.days, messages: loaded.history.length },
      });
      return reply.code(201).send({ share });
    });

    api.get("/conversations/:id/shares", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      if (!(await conversationStore.get(user, params.data.id))) return conversationNotFound(request, reply, user, params.data.id);
      return { shares: await shares.list(user, params.data.id) };
    });

    api.delete("/shares/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const params = z.object({ id: z.uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      if (!(await shares.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
      await kit.record(request, user, { eventType: "share.revoke", targetType: "share", targetId: params.data.id });
      return reply.code(204).send();
    });

    // Le jeton voyage dans le corps (jamais dans l'adresse : elle finit dans les journaux).
    const checkShareOpenLimit = api.createRateLimit({ max: 30, timeWindow: "1 minute", keyGenerator: (request) => `share-open:${kit.principal(request).userId}` });
    api.post("/shares/open", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const limit = await checkShareOpenLimit(request);
      if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
      const body = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });
      const opened = await shares.open(user, body.data.token);
      if (!opened) {
        await kit.record(request, user, { eventType: "share.view", outcome: "denied", targetType: "share", details: { reason: "unknown_or_expired" } });
        return reply.code(404).send({ error: "Not found" });
      }
      if (!opened.mine) await kit.record(request, user, { eventType: "share.view", targetType: "share", targetId: opened.id });
      return { share: opened };
    });

    /** Données personnelles des autres modules (prompts, mémoire), pour l'export RGPD. */
    async function personalData(user: AuthenticatedUser): Promise<Record<string, unknown>> {
      const mine = (await prompts.list(user)).filter((prompt) => prompt.mine);
      return {
        prompts: mine.map(({ name, content, shared, updatedAt }) => ({ name, content, shared, updatedAt })),
        memories: (await memories.list(user)).map(({ content, createdAt }) => ({ content, createdAt })),
      };
    }

    /** Outils permis pour cette réponse : organisation ∩ agent (voir agent/catalog.ts). */
    async function permittedFor(user: AuthenticatedUser, agent: Agent | null) {
      const organization = deps.settings ? (await deps.settings.get(user)).tools : defaultOrganizationTools;
      return permittedTools(organization, agent?.tools ?? null);
    }

    /**
     * Outils confiés au modèle : recherche (si le plan l'a retenue), puis
     * écritures. Écrire dans la base de l'agent suppose de pouvoir modifier
     * l'agent : un simple utilisateur de l'agent ne peut pas l'enrichir.
     */
    function agentTools(
      request: FastifyRequest,
      user: AuthenticatedUser,
      agent: Agent | null,
      selection: ModelSelection | undefined,
      plan: KnowledgePlan,
      permitted: Set<ToolId>,
      context: { confidential: boolean; citations: CitationRegistry; web: WebSession; conversationId: string; codeRuns: { count: number } },
    ): AgentTool[] {
      if (!models.supportsTools?.(selection)) return [];
      const tools: AgentTool[] = plan.mode === "agent" ? [...plan.tools] : [];
      // Recherche web : configurée sur la plateforme, choisie, et jamais pour une
      // conversation confidentielle (la requête partirait vers les moteurs publics).
      if (permitted.has("web_search") && deps.webSearch && deps.knowledge && !context.confidential) {
        const knowledge = deps.knowledge;
        tools.push(
          ...webTools({
            engine: deps.webSearch,
            readPage: (url, signal) => knowledge.readWebPage(user, url, signal),
            citations: context.citations,
            session: context.web,
          }),
        );
      }
      // Interpréteur de code : bac à sable local, sans réseau (permis même en confidentiel).
      if (permitted.has("code_interpreter") && deps.sandbox) {
        // Fichiers d'anciennes réponses jamais terminées : purgés au passage.
        void generatedFiles.purgeOrphans(user).catch(() => undefined);
        tools.push(
          codeTool({
            sandbox: deps.sandbox,
            scanner: deps.scanner,
            saveFile: (file) => generatedFiles.create(user, context.conversationId, file),
            runs: context.codeRuns,
          }),
        );
      }
      if (permitted.has("save_to_knowledge") && deps.knowledge && agent && canManageAgent(user, agent)) {
        tools.push(
          knowledgeWriteTool({
            service: deps.knowledge,
            tenant: user,
            agentId: agent.id,
            scanner: deps.scanner,
            audit: (event) =>
              kit.record(request, user, { eventType: "knowledge.source_create", targetType: "knowledge_source", ...event }),
          }),
        );
      }
      return tools;
    }

    /**
     * Outils MCP de l'agent : serveurs approuvés qu'il a choisis, outils dont
     * l'empreinte n'a pas changé. Jamais pour une conversation confidentielle :
     * les arguments partiraient vers un service tiers.
     */
    async function mcpTools(
      request: FastifyRequest,
      user: AuthenticatedUser,
      agent: Agent | null,
      selection: ModelSelection | undefined,
      permitted: Set<ToolId>,
      confidential: boolean,
      signal: AbortSignal,
    ): Promise<AgentTool[]> {
      if (!deps.mcp || !agent?.mcpServers.length || !permitted.has("mcp") || confidential || !models.supportsTools?.(selection)) return [];
      const store = deps.mcp.store;
      const servers = (await Promise.all(agent.mcpServers.map((id) => store.connection(user, id)))).filter((server) => server !== null);
      const audit = (eventType: string, server: { id: string }, details: Record<string, string>, outcome?: "denied" | "failure") =>
        void kit
          .record(request, user, { eventType, targetType: "mcp_server", targetId: server.id, ...(outcome ? { outcome } : {}), details: { ...details, agentId: agent.id } })
          .catch(() => undefined);
      return mcpToolsFor(
        servers,
        {
          // Outil modifié par le serveur depuis l'approbation : bloqué, et signalé.
          changed: (server, tool) => audit("mcp.tool_changed", server, { tool }, "denied"),
          unavailable: (server) => audit("mcp.server_unavailable", server, {}, "failure"),
          called: (server, tool, outcome) => audit("mcp.tool_call", server, { tool }, outcome === "failure" ? "failure" : undefined),
        },
        { signal, checkAddress: deps.mcp.checkAddress, ...(deps.mcp.fetcher ? { fetcher: deps.mcp.fetcher } : {}) },
      );
    }

    /**
     * Outil compté (code, web, MCP) : refusé au-delà du plafond mensuel de
     * l'organisation, compté à chaque exécution. Le refus est un résultat lu par
     * le modèle (il répond sans l'outil), et un événement d'audit.
     */
    function meteredTool(request: FastifyRequest, user: AuthenticatedUser, tool: AgentTool, limits: OrganizationSettings["toolLimits"]): AgentTool {
      const meter = meterOf(tool.name);
      if (!meter) return tool;
      return {
        ...tool,
        async execute(args, context) {
          const limit = limits[meter];
          if (limit !== undefined && ((await toolUsage.toolUsage(user))[meter] ?? 0) >= limit) {
            await kit.record(request, user, {
              eventType: "quota.tool_exceeded",
              outcome: "denied",
              targetType: "organization",
              targetId: user.organizationId,
              details: { meter, limit },
            });
            return { content: `Quota mensuel de l'organisation atteint pour cet outil (${limit} appels). Réponds sans lui et dis-le à l'utilisateur.`, summary: "quota atteint" };
          }
          try {
            return await tool.execute(args, context);
          } finally {
            // Compté même en cas d'échec : la ressource a été consommée.
            await toolUsage.recordTool(user, meter).catch((error: unknown) => request.log.error({ err: error }, "Comptage d'outil impossible"));
          }
        },
      };
    }

    // ---- Exécution durable (runs) --------------------------------------------
    //
    // Une réponse est un run enregistré en base : la connexion HTTP ne fait que
    // l'OBSERVER (événements SSE). Fermer l'onglet ne l'arrête pas ; seul
    // « arrêter » (POST …/run/cancel) le fait. Après chaque étape, l'état du
    // graphe est enregistré (chiffré) : une validation met le run en pause et
    // libère le serveur ; un redémarrage ou une panne laisse expirer le bail,
    // et une instance reprend le run là où il s'était arrêté.

    /** Repli de la connaissance pour un run repris : outils recréés, droits revérifiés. */
    async function resumePlan(
      user: AuthenticatedUser,
      conversation: ConversationSummary,
      agent: Agent | null,
      selection: ModelSelection | undefined,
      provider: ProviderId | "echo",
      turns: ChatTurn[],
      permitted: Set<ToolId>,
    ): Promise<KnowledgePlan> {
      const bases = await activeBases(user, conversation, agent);
      if (bases.some((base) => base.confidential) && provider !== "local" && provider !== "echo") throw new RunFailure("Local model required");
      if (bases.length && models.supportsTools?.(selection) && permitted.has("search_knowledge")) {
        // Même numérotation des sources qu'avant la pause.
        const citations = new CitationRegistry().seed(turns);
        return { mode: "agent", citations, tools: [knowledgeTool(deps.knowledge!, user, bases, citations)] };
      }
      return { mode: "none" };
    }

    /** Enregistre la réponse, compte la consommation, trace. */
    async function completeRun(
      request: FastifyRequest,
      user: AuthenticatedUser,
      run: RunRecord,
      answer: string,
      sources: MessageSource[],
      outcome: { usage?: TokenUsage | undefined; model: string; partial: boolean; steps: number },
    ) {
      const { request: input } = run;
      const payload =
        input.kind === "message"
          ? await conversationStore
              .appendExchange(user, run.conversationId, input.content, answer, {
                attachmentIds: input.attachmentIds,
                ...(input.editMessageId ? { replaceFromMessageId: input.editMessageId } : {}),
                ...(sources.length ? { sources } : {}),
                runId: run.id,
              })
              .then((exchange) => (exchange ? { userMessage: exchange.userMessage, assistantMessage: exchange.assistantMessage } : null))
          : await conversationStore
              .replaceLastAssistant(user, run.conversationId, input.previousAssistantId ?? "", answer, sources.length ? sources : undefined, run.id)
              .then((assistantMessage) => (assistantMessage ? { assistantMessage } : null));
      if (!payload) return null;

      // Le fournisseur ne compte pas toujours (arrêt, echo) : estimation prudente.
      const counted = outcome.usage ?? { inputTokens: estimateTokens(input.content), outputTokens: estimateTokens(answer) };
      deps.metrics?.tokens.inc({ provider: input.provider, direction: "input" }, counted.inputTokens);
      deps.metrics?.tokens.inc({ provider: input.provider, direction: "output" }, counted.outputTokens);
      // Inclus dans « input » : le rapport des deux mesure l'efficacité du cache.
      if (counted.cachedInputTokens) deps.metrics?.tokens.inc({ provider: input.provider, direction: "cached_input" }, counted.cachedInputTokens);
      await deps.settings?.record(user, input.provider, counted).catch((error: unknown) => {
        request.log.error({ err: error }, "Échec d'enregistrement de la consommation");
      });
      await kit.record(request, user, {
        eventType: input.kind === "message" ? "message.create" : "message.regenerate",
        targetType: "conversation",
        targetId: run.conversationId,
        details: {
          ...input.details,
          agentId: input.agentId ?? "",
          model: outcome.model,
          inputTokens: counted.inputTokens,
          outputTokens: counted.outputTokens,
          // Part de l'entrée servie par le cache du fournisseur (efficacité du cache).
          cachedInputTokens: counted.cachedInputTokens ?? 0,
          partial: outcome.partial,
          steps: outcome.steps,
        },
      });
      return payload;
    }

    /**
     * Compaction en arrière-plan : si l'historique non résumé dépasse le seuil,
     * les échanges anciens sont résumés (avec le résumé précédent) par le modèle
     * de la conversation. Échec sans conséquence : l'historique est alors tronqué.
     */
    async function compact(request: FastifyRequest, user: AuthenticatedUser, conversationId: string, input: RunRequest) {
      if (!deps.summarize) return;
      try {
        const messages = await conversationStore.getMessages(user, conversationId);
        if (!messages) return;
        const candidate = compactionCandidate(messages, await summaries.get(user, conversationId));
        if (!candidate) return;
        const result = await deps.summarize({ selection: input.selection, previous: candidate.previous, messages: candidate.fold });
        if (!result) return;
        await summaries.set(user, conversationId, {
          uptoMessageId: candidate.uptoMessageId,
          coveredMessages: candidate.coveredMessages,
          summary: result.summary,
          model: result.model,
        });
        if (result.usage) await deps.settings?.record(user, input.provider, result.usage);
        await kit.record(request, user, {
          eventType: "conversation.compacted",
          targetType: "conversation",
          targetId: conversationId,
          details: { messages: candidate.coveredMessages, model: result.model, outputTokens: result.usage?.outputTokens ?? 0 },
        });
      } catch (error) {
        request.log.warn({ err: error }, "Compaction de la conversation impossible");
      }
    }

    /** Arrêt demandé : la réponse partielle est gardée (comme avant), le run effacé. */
    async function cancelRun(request: FastifyRequest, user: AuthenticatedUser, run: RunRecord, text: string, plan?: KnowledgePlan) {
      for (const pending of run.progress.pending) {
        await kit.record(request, user, {
          eventType: "tool.approval",
          outcome: "denied",
          targetType: "conversation",
          targetId: run.conversationId,
          details: { tool: pending.name, decision: "cancelled", agentId: run.request.agentId ?? "" },
        });
      }
      const payload = text.trim()
        ? await completeRun(request, user, run, text, plan ? knowledgeSources(plan, text) : (run.request.sources ?? []), {
            model: run.request.provider,
            partial: true,
            steps: run.progress.steps.length,
          })
        : null;
      await runs.finish(user, run.id);
      await checkpointerFor(user).deleteThread(run.id);
      runEvents.emit(run.id, payload ? { type: "done", payload } : { type: "error", error: "Cancelled" });
    }

    /**
     * Exécute (ou reprend) un run. start : premier passage, avec l'entrée du
     * modèle ; resume : décisions de validation ; continue : reprise après panne.
     */
    async function executeRun(
      request: FastifyRequest,
      user: AuthenticatedUser,
      run: RunRecord,
      mode: { start?: { input: RunInput; plan: KnowledgePlan }; resume?: Record<string, boolean>; continue?: boolean },
    ) {
      const controller = new AbortController();
      let stopReason: "cancel" | "lost" | "shutdown" | "limit" | null = null;
      const stop = (reason: NonNullable<typeof stopReason>) => {
        stopReason ??= reason;
        controller.abort();
      };
      localRuns.set(run.id, { stop });
      const emit = (event: RunEvent) => runEvents.emit(run.id, event);
      const progress: RunProgress = { ...structuredClone(run.progress), pending: [] };
      const provider = run.request.provider;
      const started = performance.now();
      const observe = (outcome: "success" | "aborted" | "refused" | "rate_limited" | "error" | "paused") =>
        deps.metrics?.generation.observe({ provider, outcome }, (performance.now() - started) / 1000);

      // Bail : prolongé régulièrement (avec l'avancement, pour une reconnexion).
      // Perdu (autre instance) ou arrêt demandé ailleurs : on s'arrête.
      const lease = setInterval(() => {
        runs
          .renew(user, run.id, instance, RUN_LEASE_MS, progress)
          .then((state) => {
            if (!state.held) stop("lost");
            else if (state.cancelRequested) stop("cancel");
          })
          .catch((error: unknown) => request.log.error({ err: error }, "Renouvellement du bail impossible"));
      }, RUN_RENEW_MS);
      lease.unref();
      // Durée maximale d'un passage : la réponse s'arrête, comme sur « arrêter ».
      const deadline = setTimeout(() => stop("limit"), timing.maxActiveMs);
      deadline.unref();

      let plan: KnowledgePlan = mode.start?.plan ?? { mode: "none" };
      const saver = checkpointerFor(user);
      let runTrace: RunTrace | undefined;
      try {
        const conversation = await conversationStore.get(user, run.conversationId);
        if (!conversation) throw new RunFailure("Not found");
        const agent = run.request.agentId && agents ? await agents.get(user, run.request.agentId) : null;
        const selection = run.request.selection;
        // Base confidentielle : aucun contenu dans les traces, aucune recherche web.
        const confidential = (await activeBases(user, conversation, agent)).some((base) => base.confidential);
        // Trace de ce passage du run ; une base confidentielle n'y laisse jamais de contenu.
        runTrace = tracer.startRun({
          runId: run.id,
          conversationId: run.conversationId,
          userId: user.userId,
          organizationId: user.organizationId,
          kind: run.request.kind,
          provider,
          model: selection ? `${selection.provider}:${selection.model}` : provider,
          agent: agent ? { id: agent.id, name: agent.name } : undefined,
          resumed: !mode.start,
          // Conversation temporaire : comme une base confidentielle, rien du contenu dans la trace.
          confidential: confidential || conversation.temporary === true,
          question: mode.start ? run.request.content : undefined,
        });
        // Reprise : le modèle doit toujours être autorisé (l'admin a pu changer d'avis).
        if (!mode.start && selection && !(await isModelPermitted(user, selection))) throw new RunFailure("Provider unavailable");
        const permitted = await permittedFor(user, agent);

        let input: RunInput = mode.start?.input ?? { history: [], message: "", images: [] };
        // Transcription déjà produite (reprise) : sources et pages lues retrouvées.
        let earlier: ChatTurn[] = [];
        if (!mode.start) {
          const values = (await saver.getTuple({ configurable: { thread_id: run.id } }))?.checkpoint.channel_values as
            | { turns?: ChatTurn[]; response?: string }
            | undefined;
          if (!values) throw new RunFailure("Not found");
          // Texte déjà produit avant la pause ou la panne (l'étape en cours sera rejouée).
          progress.text = values.response ?? "";
          earlier = values.turns ?? [];
          plan = await resumePlan(user, conversation, agent, selection, provider, earlier, permitted);
          input = { history: [], message: "", images: [] };
        }
        // Une seule numérotation [n] pour la base et le web, sur toute la réponse.
        const citations = plan.mode === "agent" ? plan.citations : new CitationRegistry().seed(earlier);
        const tools = agentTools(request, user, agent, selection, plan, permitted, {
          confidential,
          citations,
          web: new WebSession(run.request.content).seed(earlier),
          conversationId: run.conversationId,
          codeRuns: { count: earlier.filter((turn) => turn.role === "tool" && turn.name === "run_code").length },
        });
        tools.push(...(await mcpTools(request, user, agent, selection, permitted, confidential, controller.signal)));
        // Mémoire : activée par l'utilisateur, jamais en conversation temporaire ni
        // confidentielle (rien n'en sort, rien n'y entre).
        const memoryOn = !conversation.temporary && !confidential && deps.preferences ? (await deps.preferences.get(user)).memory : false;
        const remembered = memoryOn ? (await memories.list(user)).map((memory) => memory.content) : [];
        if (memoryOn && kit.canWrite(user) && models.supportsTools?.(selection)) {
          tools.push(
            memoryTool({
              store: memories,
              tenant: user,
              audit: (event) => kit.record(request, user, { eventType: "memory.create", targetType: "memory", ...event, details: { ...event.details, source: "agent" } }),
            }),
          );
        }
        const limits = deps.settings ? (await deps.settings.get(user)).toolLimits : {};
        // Garde contre les injections : contenus suspects avertis et audités ; une
        // écriture demandée ensuite porte une alerte sur sa carte de validation.
        const startTexts = [input.message, ...input.history.map((turn) => turn.content), ...earlier.map((turn) => turn.content)];
        const taint = { tainted: carriesNotice(startTexts) };
        if (mode.start && carriesNotice([input.message])) {
          await kit.record(request, user, { eventType: "agent.injection_suspected", targetType: "conversation", targetId: run.conversationId, details: { source: "attachment" } });
        }
        const guarded = guardTools(tools, taint, (tool, verdict) => {
          void kit.record(request, user, {
            eventType: "agent.injection_suspected",
            targetType: "conversation",
            targetId: run.conversationId,
            details: { source: "tool", tool, signals: verdict.signals.join(","), score: verdict.score },
          });
        });
        const metered = guarded.map((tool) => meteredTool(request, user, tool, limits));

        const result = await runnerFor(selection)(
          {
            message: input.message,
            history: input.history,
            images: input.images,
            instructions: agent?.instructions,
            summary: input.summary,
            ...(remembered.length ? { memories: remembered } : {}),
            ...(metered.length ? { tools: metered, maxSteps: deps.agentMaxSteps, maxTokens: deps.agentMaxTokens } : {}),
            // Réglages de l'agent (créativité, longueur), plafonnés par chaque fournisseur.
            ...(agent && Object.keys(generationOf(agent.parameters)).length ? { generation: generationOf(agent.parameters) } : {}),
          },
          {
            signal: controller.signal,
            onToken: (text) => {
              progress.text += text;
              emit({ type: "token", text });
            },
            onReasoning: (text) => {
              progress.reasoning = (progress.reasoning ?? "") + text;
              emit({ type: "reasoning", text });
            },
            onTool: (event) => {
              const index = progress.steps.findIndex((step) => step.id === event.id);
              if (index === -1) progress.steps.push(event);
              else progress.steps[index] = event;
              emit({ type: "step", step: event });
            },
            trace: runTrace,
            durable: {
              checkpointer: saver,
              threadId: run.id,
              ...(mode.resume ? { resume: mode.resume } : {}),
              ...(mode.continue ? { continue: true } : {}),
            },
          },
        );

        if (result.pending?.length) {
          // Pause : état enregistré, serveur libéré ; la décision reprendra le run.
          progress.text = result.content;
          progress.pending = result.pending;
          await runs.pause(user, run.id, instance, progress);
          observe("paused");
          runTrace.end({ status: "paused", usage: result.usage });
          for (const approval of result.pending) emit({ type: "approval", approval });
          emit({ type: "paused" });
          return;
        }

        observe("success");
        runTrace.end({ status: "done", output: result.content, usage: result.usage });
        const sources =
          plan.mode === "inline"
            ? knowledgeSources(plan, result.content)
            : citations.size
              ? citations.citations(result.content)
              : (run.request.sources ?? []);
        const payload = await completeRun(request, user, run, result.content, sources, {
          usage: result.usage,
          model: result.model,
          partial: false,
          steps: result.steps ?? 0,
        });
        // Fichiers produits par le code : rattachés à la réponse enregistrée.
        const fileIds = generatedFileIds(result.turns ?? []);
        if (payload && fileIds.length) await generatedFiles.attach(user, run.conversationId, payload.assistantMessage.id, fileIds);
        await runs.finish(user, run.id);
        await saver.deleteThread(run.id);
        emit(payload ? { type: "done", payload } : { type: "error", error: "Not found" });
        // Conversation devenue longue : résumé des échanges anciens, en arrière-plan.
        if (payload) void compact(request, user, run.conversationId, run.request);
      } catch (error) {
        if (controller.signal.aborted) {
          observe("aborted");
          runTrace?.end({ status: stopReason === "cancel" ? "cancelled" : "interrupted" });
          // Arrêt demandé ou durée maximale : réponse partielle gardée. Bail perdu
          // ou arrêt du serveur : rien n'est effacé, une instance reprendra le run.
          if (stopReason === "limit") {
            await kit.record(request, user, {
              eventType: "agent.run_limit",
              outcome: "denied",
              targetType: "conversation",
              targetId: run.conversationId,
              details: { limit: "duration", seconds: Math.round(timing.maxActiveMs / 1000) },
            });
          }
          if (stopReason === "cancel" || stopReason === "limit") {
            const text = stopReason === "limit" && progress.text.trim() ? `${progress.text}\n\n_${LIMIT_NOTICE}_` : progress.text;
            await cancelRun(request, user, run, text, plan).catch((cause: unknown) => {
              request.log.error({ err: cause }, "Échec d'enregistrement de la réponse partielle");
            });
          }
          return;
        }
        observe(error instanceof ModelRefusalError ? "refused" : isRateLimit(error) ? "rate_limited" : "error");
        runTrace?.end({ status: "error", error });
        request.log.error({ err: error }, "Échec du run d'agent");
        await runs.finish(user, run.id).catch(() => undefined);
        await saver.deleteThread(run.id).catch(() => undefined);
        emit({
          type: "error",
          error:
            error instanceof RunFailure
              ? error.message
              : error instanceof ModelRefusalError
                ? "Refused"
                : isRateLimit(error)
                  ? "Provider rate limited"
                  : error instanceof ProviderUnavailableError
                    ? "Provider unavailable"
                    : "Assistant unavailable",
        });
      } finally {
        clearInterval(lease);
        clearTimeout(deadline);
        localRuns.delete(run.id);
      }
    }

    /**
     * Flux SSE d'un run : "token", "step", "approval", puis "done", "error" ou
     * "paused" (attente de validation). La fermeture de la connexion
     * n'interrompt PAS le run.
     */
    function observeRun(
      reply: FastifyReply,
      runId: string,
      start: (local: { emit: (event: RunEvent) => void }) => void,
      snapshot?: RunProgress & { status: string },
    ) {
      const stream = new PassThrough();
      const send = (event: string, data: unknown) => stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => stream.write(": ping\n\n"), 15_000);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        stream.end();
      };
      const sendSnapshot = (progress: RunProgress, status: string) =>
        send("snapshot", { status, text: progress.text, reasoning: progress.reasoning ?? "", steps: progress.steps, approvals: progress.pending.map(approvalView) });
      const handle = (event: RunEvent) => {
        if (closed) return;
        if (event.type === "token") send("token", { text: event.text });
        else if (event.type === "reasoning") send("reasoning", { text: event.text });
        else if (event.type === "step") send("step", event.step);
        else if (event.type === "approval") send("approval", approvalView(event.approval));
        else if (event.type === "snapshot") sendSnapshot(event.progress, "running");
        else {
          send(event.type, event.type === "done" ? event.payload : event.type === "error" ? { error: event.error } : {});
          close();
        }
      };
      const unsubscribe = runEvents.subscribe(runId, handle);
      reply.raw.on("close", close);
      observers.add(close);
      stream.on("close", () => observers.delete(close));
      if (snapshot) sendSnapshot(snapshot, snapshot.status);
      start({ emit: handle });
      reply.header("Content-Type", "text/event-stream; charset=utf-8");
      reply.header("X-Accel-Buffering", "no");
      return reply.send(stream);
    }

    /** Ce que l'interface reçoit d'une demande de validation. */
    const approvalView = (approval: PendingApproval) => ({
      id: approval.id,
      stepId: approval.callId,
      tool: approval.name,
      title: approval.preview.title,
      detail: approval.preview.detail ?? "",
      ...(approval.preview.warning ? { warning: true } : {}),
      ...(approval.preview.exposure ? { exposure: true } : {}),
    });

    /** Lance un nouveau run et en diffuse les événements. */
    async function startRun(options: {
      request: FastifyRequest;
      reply: FastifyReply;
      user: AuthenticatedUser;
      conversationId: string;
      run: RunRequest;
      input: RunInput;
      plan: KnowledgePlan;
    }) {
      const { request, reply, user } = options;
      const run = await runs.create(user, options.conversationId, options.run, instance, RUN_LEASE_MS);
      if (!run) return reply.code(409).send({ error: "Run in progress" });
      return observeRun(reply, run.id, () => {
        void executeRun(request, user, run, { start: { input: options.input, plan: options.plan } });
      });
    }

    /** Rôle actuel du propriétaire d'un run repris en arrière-plan (null : plus membre). */
    async function currentRole(tenant: { organizationId: string; userId: string }, fallback: string) {
      if (!deps.members) return fallback as AuthenticatedUser["role"];
      const member = (await deps.members.list(tenant)).find((item) => item.userId === tenant.userId);
      return member?.role ?? null;
    }

    /**
     * Reprise des runs orphelins (instance tombée, redémarrage) et refus des
     * validations restées sans réponse trop longtemps.
     */
    async function recoverRuns() {
      const system = { ip: "system", id: "agent-run-recovery", log: app.log } as unknown as FastifyRequest;
      for (const stale of await runs.stale(RUN_APPROVAL_TTL_S)) {
        const tenant = { organizationId: stale.organizationId, userId: stale.userId };
        try {
          const claimed = await runs.claim({ ...tenant }, stale.runId, instance, RUN_LEASE_MS);
          if (!claimed) continue;
          const role = await currentRole(tenant, claimed.request.role);
          const user: AuthenticatedUser = { ...tenant, role: role ?? "reader" };
          if (!role) {
            // Plus membre de l'organisation : rien n'est repris ni enregistré.
            await runs.finish(user, claimed.id);
            await checkpointerFor(user).deleteThread(claimed.id);
            continue;
          }
          if (stale.status === "waiting") {
            for (const pending of claimed.progress.pending) {
              await kit.record(system, user, {
                eventType: "tool.approval",
                outcome: "denied",
                targetType: "conversation",
                targetId: claimed.conversationId,
                details: { tool: pending.name, decision: "expired", agentId: claimed.request.agentId ?? "" },
              });
            }
            void executeRun(system, user, claimed, { resume: Object.fromEntries(claimed.progress.pending.map((pending) => [pending.id, false])) });
          } else {
            void executeRun(system, user, claimed, { continue: true });
          }
        } catch (error) {
          app.log.error({ err: error, run: stale.runId }, "Reprise du run impossible");
        }
      }
    }

    /** Conversations temporaires échues : effacées comme une suppression par leur auteur. */
    async function purgeTemporary() {
      const system = { ip: "system", id: "temporary-purge", log: app.log } as unknown as FastifyRequest;
      for (const expired of (await conversationStore.expiredTemporary?.()) ?? []) {
        const owner = { organizationId: expired.organizationId, userId: expired.userId };
        try {
          if (!(await conversationStore.delete(owner, expired.conversationId))) continue;
          await kit.record(system, { ...owner, role: "reader" }, {
            eventType: "conversation.purge",
            targetType: "conversation",
            targetId: expired.conversationId,
            details: { reason: "temporary_expired" },
          });
        } catch (error) {
          app.log.error({ err: error, conversation: expired.conversationId }, "Purge de la conversation temporaire impossible");
        }
      }
    }

    api.addHook("onReady", async () => {
      recoverRuns().catch((error: unknown) => app.log.error({ err: error }, "Reprise des runs impossible"));
      purgeTemporary().catch((error: unknown) => app.log.error({ err: error }, "Purge des conversations temporaires impossible"));
    });
    const recovery = setInterval(() => {
      recoverRuns().catch((error: unknown) => app.log.error({ err: error }, "Reprise des runs impossible"));
      purgeTemporary().catch((error: unknown) => app.log.error({ err: error }, "Purge des conversations temporaires impossible"));
    }, RUN_RECOVERY_MS);
    recovery.unref();
    // Arrêt du serveur : les runs locaux s'interrompent sans rien effacer ; leur
    // bail expire et ils seront repris (ici au redémarrage, ou par une autre instance).
    api.addHook("onClose", async () => {
      // Traces en attente envoyées avant l'arrêt.
      await tracer.shutdown().catch(() => undefined);
    });
    api.addHook("preClose", async () => {
      clearInterval(recovery);
      for (const local of localRuns.values()) local.stop("shutdown");
      // Flux observés fermés : le client se reconnecte (à une autre instance, ou après le redémarrage).
      for (const close of [...observers]) close();
    });

    /** Paramètres de génération selon le mode de connaissance retenu. */
    const knowledgeInput = (plan: KnowledgePlan, input: { history: ChatTurn[]; message: string; images: ModelImage[] }) =>
      plan.mode === "inline" ? withKnowledge(input, plan.passages) : input;
    const knowledgeSources = (plan: KnowledgePlan, answer: string) =>
      plan.mode === "inline" ? citationsOf(plan.passages) : plan.mode === "agent" ? plan.citations.citations(answer) : [];
    const knowledgeDetail = (plan: KnowledgePlan) =>
      plan.mode === "inline" ? plan.passages.length : plan.mode === "agent" ? "agent" : 0;

    /**
     * Question de suivi rendue autonome pour la recherche, par le modèle de la
     * conversation (consommation comptée) ; repli simple en cas d'échec.
     */
    async function standaloneQuery(
      request: FastifyRequest,
      user: AuthenticatedUser,
      selection: ModelSelection | undefined,
      provider: ProviderId | "echo",
      history: ChatTurn[],
      message: string,
    ) {
      if (deps.rewriteQuery) {
        try {
          const rewritten = await deps.rewriteQuery({ selection, history, message });
          if (rewritten) {
            if (rewritten.usage) {
              await deps.settings?.record(user, provider, rewritten.usage).catch(() => undefined);
            }
            return rewritten.query;
          }
        } catch (error) {
          request.log.warn({ err: error }, "Reformulation de la question impossible, repli simple");
        }
      }
      return heuristicStandalone(history, message);
    }

    /** Les passages précèdent la question, balisés comme des données. */
    const withKnowledge = (input: { history: ChatTurn[]; message: string; images: ModelImage[] }, passages: Passage[]) =>
      passages.length ? { ...input, message: `${renderKnowledge(passages)}\n\n${input.message}` } : input;

    api.post("/conversations/:id/messages", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      if (!(await messageLimit(request, reply))) return reply;
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      const body = messageSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "Invalid request" });
      }
      const { content, attachmentIds, editMessageId } = body.data;

      const loaded = await loadConversation(request, reply, user, params.data.id);
      if (!loaded) return reply;
      const { history, agent, selection } = loaded;

      // Modification : le contexte s'arrête juste avant le message édité.
      let prior = history;
      if (editMessageId) {
        const index = history.findIndex((message) => message.id === editMessageId && message.role === "user");
        if (index === -1) return reply.code(400).send({ error: "Invalid request" });
        prior = history.slice(0, index);
      }

      if (attachmentIds.length > 0) {
        const claimable = deps.attachments
          ? await deps.attachments.claimable(user, params.data.id, attachmentIds, editMessageId)
          : [];
        if (claimable.length !== new Set(attachmentIds).size) {
          return reply.code(400).send({ error: "Invalid request" });
        }
      }

      // Une réponse déjà en cours (ou en attente de validation) : refus avant tout coût.
      if (await runs.active(user, params.data.id)) return reply.code(409).send({ error: "Run in progress" });
      const admitted = await admitGeneration(request, reply, user, selection);
      if (!admitted) return reply;

      const permitted = await permittedFor(user, agent);
      const plan = await retrieveKnowledge(request, reply, user, loaded, admitted.provider, { message: content, history: prior }, permitted);
      if (!plan) return reply;

      // Résumé des échanges anciens (s'il existe) + messages récents dans le budget.
      const { history: context, summary } = planContext(prior, await summaries.get(user, params.data.id));
      const files = await modelFiles(user, params.data.id, context, attachmentIds);

      return startRun({
        request,
        reply,
        user,
        conversationId: params.data.id,
        input: { ...knowledgeInput(plan, buildModelInput(context, { content, attachmentIds }, files)), summary },
        plan,
        run: {
          kind: "message",
          content,
          attachmentIds,
          editMessageId,
          agentId: agent?.id ?? null,
          selection,
          provider: admitted.provider,
          role: user.role,
          ...(plan.mode === "inline" ? { sources: citationsOf(plan.passages) } : {}),
          details: { attachments: attachmentIds.length, edited: Boolean(editMessageId), passages: knowledgeDetail(plan) },
        },
      });
    });

    // ---- Fichiers produits par l'interpréteur de code -------------------------

    const fileParams = z.object({ id: conversationIdSchema, fileId: z.uuid() });

    api.get("/conversations/:id/files", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const params = runParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      return { files: await generatedFiles.list(user, params.data.id) };
    });

    /**
     * Contenu d'un fichier produit. Seules les images matricielles s'affichent ;
     * tout le reste (SVG compris, qui peut contenir du script) se télécharge.
     * CSP « sandbox » : ouvert directement, rien ne s'exécute dans l'origine de Snowfall.
     */
    api.get("/conversations/:id/files/:fileId", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const params = fileParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      const file = await generatedFiles.content(user, params.data.id, params.data.fileId);
      if (!file) return reply.code(404).send({ error: "Not found" });
      const inline = file.mediaType === "image/png" || file.mediaType === "image/jpeg";
      reply.header("Content-Type", file.mediaType);
      reply.header("Content-Security-Policy", "default-src 'none'; sandbox");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      return reply.send(file.bytes);
    });

    // ---- Routes des runs ------------------------------------------------------

    const runParams = z.object({ id: conversationIdSchema });
    // Identifiant de demande : celui de l'interruption LangGraph (empreinte hexadécimale).
    const approvalParams = z.object({ id: conversationIdSchema, approvalId: z.string().regex(/^[a-f0-9]{16,64}$/) });
    const approvalBody = z.object({ approved: z.boolean() }).strict();

    /**
     * Réponse à une demande de validation. Le run en pause est repris ici, quelle
     * que soit l'instance qui l'avait lancé, et la suite est diffusée en SSE.
     */
    api.post("/conversations/:id/approvals/:approvalId", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
      const params = approvalParams.safeParse(request.params);
      const body = approvalBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });

      // RLS : seul le propriétaire de la conversation voit son run.
      const run = await runs.active(user, params.data.id);
      const pending = run?.status === "waiting" ? run.progress.pending.find((item) => item.id === params.data.approvalId) : undefined;
      if (!run || !pending) {
        // Inconnue, déjà tranchée, expirée, ou demande d'un autre utilisateur : même réponse, tracée.
        await kit.record(request, user, {
          eventType: "tool.approval",
          outcome: "denied",
          targetType: "conversation",
          targetId: params.data.id,
          details: { reason: "unknown_request" },
        });
        return reply.code(404).send({ error: "Not found" });
      }
      const claimed = await runs.claim(user, run.id, instance, RUN_LEASE_MS);
      if (!claimed) return reply.code(409).send({ error: "Run in progress" });

      await kit.record(request, user, {
        eventType: "tool.approval",
        outcome: body.data.approved ? "success" : "denied",
        targetType: "conversation",
        targetId: params.data.id,
        details: { tool: pending.name, decision: body.data.approved ? "approved" : "denied", agentId: claimed.request.agentId ?? "" },
      });
      return observeRun(reply, run.id, () => {
        void executeRun(request, user, claimed, { resume: { [pending.id]: body.data.approved } });
      });
    });

    /** Arrêter la réponse : le run est interrompu où qu'il s'exécute ; le partiel est gardé. */
    api.post("/conversations/:id/run/cancel", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
      const params = runParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const run = await runs.active(user, params.data.id);
      if (!run) return reply.code(404).send({ error: "Not found" });
      const local = localRuns.get(run.id);
      if (local) {
        local.stop("cancel");
      } else if (run.status === "waiting") {
        const claimed = await runs.claim(user, run.id, instance, RUN_LEASE_MS);
        if (claimed) await cancelRun(request, user, claimed, claimed.progress.text);
      } else {
        // Exécuté par une autre instance : elle le verra au prochain renouvellement du bail.
        await runs.requestCancel(user, run.id);
      }
      return reply.code(202).send();
    });

    /** Réponse en cours (reconnexion, autre onglet) : question, texte partiel, étapes, validations. */
    api.get("/conversations/:id/run", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const params = runParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      const run = await runs.active(user, params.data.id);
      return {
        run: run
          ? {
              id: run.id,
              status: run.status,
              kind: run.request.kind,
              question: run.request.content,
              text: run.progress.text,
              reasoning: run.progress.reasoning ?? "",
              steps: run.progress.steps,
              approvals: run.progress.pending.map(approvalView),
            }
          : null,
      };
    });

    /**
     * Reprendre le fil d'une réponse en cours : avancement enregistré, puis la
     * suite en direct. Run orphelin (bail expiré) : repris ici même.
     */
    api.get("/conversations/:id/run/events", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const params = runParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      const run = await runs.active(user, params.data.id);
      if (!run) return reply.code(404).send({ error: "Not found" });
      const snapshot = { ...run.progress, status: run.status };

      if (run.status === "waiting") {
        return observeRun(reply, run.id, ({ emit }) => emit({ type: "paused" }), snapshot);
      }
      if (localRuns.has(run.id)) return observeRun(reply, run.id, () => undefined, snapshot);

      const orphan = !run.leaseUntil || run.leaseUntil.getTime() < Date.now();
      const claimed = orphan ? await runs.claim(user, run.id, instance, RUN_LEASE_MS) : null;
      if (claimed) {
        return observeRun(reply, run.id, () => void executeRun(request, user, claimed, { continue: true }), snapshot);
      }
      // Exécuté par une autre instance : avancement relu en base chaque seconde.
      return observeRun(
        reply,
        run.id,
        ({ emit }) => {
          const poll = setInterval(() => {
            runs
              .get(user, run.id)
              .then((current) => {
                if (!current) {
                  clearInterval(poll);
                  emit({ type: "done", payload: { refresh: true } });
                } else if (current.status === "waiting") {
                  clearInterval(poll);
                  emit({ type: "paused" });
                } else {
                  emit({ type: "snapshot", progress: current.progress });
                }
              })
              .catch(() => clearInterval(poll));
          }, 1_000);
          poll.unref();
          reply.raw.on("close", () => clearInterval(poll));
        },
        snapshot,
      );
    });
    api.post("/conversations/:id/regenerate", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      if (!(await messageLimit(request, reply))) return reply;
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const loaded = await loadConversation(request, reply, user, params.data.id);
      if (!loaded) return reply;
      const { history, agent, selection } = loaded;

      // Seule la dernière réponse se régénère, à partir de la question qui la précède.
      const last = history.at(-1);
      const question = history.at(-2);
      if (last?.role !== "assistant" || question?.role !== "user") {
        return reply.code(400).send({ error: "Invalid request" });
      }

      if (await runs.active(user, params.data.id)) return reply.code(409).send({ error: "Run in progress" });
      const admitted = await admitGeneration(request, reply, user, selection);
      if (!admitted) return reply;

      const permitted = await permittedFor(user, agent);
      const plan = await retrieveKnowledge(
        request,
        reply,
        user,
        loaded,
        admitted.provider,
        { message: question.content, history: history.slice(0, -2) },
        permitted,
      );
      if (!plan) return reply;

      const { history: context, summary } = planContext(history.slice(0, -2), await summaries.get(user, params.data.id));
      const attachmentIds = question.attachments?.map((file) => file.id) ?? [];
      const files = await modelFiles(user, params.data.id, context, attachmentIds);

      return startRun({
        request,
        reply,
        user,
        conversationId: params.data.id,
        input: { ...knowledgeInput(plan, buildModelInput(context, { content: question.content, attachmentIds }, files)), summary },
        plan,
        run: {
          kind: "regenerate",
          content: question.content,
          attachmentIds,
          previousAssistantId: last.id,
          agentId: agent?.id ?? null,
          selection,
          provider: admitted.provider,
          role: user.role,
          ...(plan.mode === "inline" ? { sources: citationsOf(plan.passages) } : {}),
          details: { attachments: attachmentIds.length, passages: knowledgeDetail(plan) },
        },
      });
    });
  });

  function registerAgentRoutes(api: FastifyInstance, store: AgentStore) {
    const idParams = z.object({ id: z.uuid() });

    async function parseAgentInput(request: FastifyRequest, user: AuthenticatedUser) {
      const parsed = agentInputSchema.safeParse(request.body);
      if (!parsed.success) return null;
      // Liste blanche : fournisseur configuré, autorisé par l'organisation,
      // et modèle publié par lui.
      const [allowed, permitted, organizationTools] = await Promise.all([
        models.isAllowed({ provider: parsed.data.provider, model: parsed.data.model }),
        allowedProviders(user),
        deps.settings ? deps.settings.get(user).then((current) => current.tools) : defaultOrganizationTools,
      ]);
      if (!allowed || !permitted.includes(parsed.data.provider)) return null;
      // Outils : seulement parmi ceux de l'organisation (revérifié à chaque réponse).
      const tools = parsed.data.tools.filter((tool) => organizationTools.includes(tool));
      // Serveurs MCP : seulement des serveurs approuvés de l'organisation. Un serveur
      // suspendu reste rattaché (il revient à sa réactivation) ; à l'exécution, seuls
      // les serveurs approuvés à cet instant sont proposés.
      const approved = tools.includes("mcp") && deps.mcp
        ? new Set((await deps.mcp.store.list(user)).filter((server) => server.status !== "pending").map((server) => server.id))
        : new Set<string>();
      return { ...parsed.data, tools, mcpServers: parsed.data.mcpServers.filter((id) => approved.has(id)) };
    }

    const view = (user: AuthenticatedUser, agent: Agent) => ({
      ...agent,
      canEdit: canManageAgent(user, agent),
    });

    const auditAgent = (request: FastifyRequest, user: AuthenticatedUser, eventType: string, agent: Pick<Agent, "id"> & Partial<Agent>) =>
      kit.record(request, user, {
        eventType,
        targetType: "agent",
        targetId: agent.id,
        ...(agent.provider
          ? { details: { provider: agent.provider, model: agent.model ?? "", tools: (agent.tools ?? []).join(","), mcpServers: agent.mcpServers?.length ?? 0 } }
          : {}),
      });

    api.get("/agents", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      // Taux de 👍 de l'organisation (à partir de 5 avis), pour le catalogue.
      const ratings = deps.agentRatings ? await deps.agentRatings.ratings(user).catch(() => ({})) : {};
      return {
        agents: (await store.list(user)).map((agent) => {
          const rating = (ratings as Record<string, AgentRating>)[agent.id];
          return { ...view(user, agent), ...(rating ? { rating } : {}) };
        }),
      };
    });

    api.post("/agents", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const input = await parseAgentInput(request, user);
      if (!input) return reply.code(400).send({ error: "Invalid request" });

      const agent = await store.create(user, input);
      await auditAgent(request, user, "agent.create", agent);
      return reply.code(201).send({ agent: view(user, agent) });
    });

    api.put("/agents/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const existing = await store.get(user, params.data.id);
      if (!existing) return reply.code(404).send({ error: "Not found" });
      if (!canManageAgent(user, existing)) return kit.denyWrite(request, reply, user);

      const input = await parseAgentInput(request, user);
      if (!input) return reply.code(400).send({ error: "Invalid request" });

      // Base confidentielle : l'agent ne peut pas passer à un modèle hors plateforme.
      if (input.provider !== "local" && deps.knowledge) {
        const base = await deps.knowledge.store.findBase(user, { kind: "agent", agentId: params.data.id });
        if (base?.confidential) return reply.code(409).send({ error: "Local model required", reason: "agent_requires_local" });
      }

      const agent = await store.update(user, params.data.id, input);
      if (!agent) return reply.code(404).send({ error: "Not found" });

      await auditAgent(request, user, "agent.update", agent);
      return { agent: view(user, agent) };
    });

    api.delete("/agents/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);

      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const existing = await store.get(user, params.data.id);
      if (!existing) return reply.code(404).send({ error: "Not found" });
      if (!canManageAgent(user, existing)) return kit.denyWrite(request, reply, user);

      await store.delete(user, params.data.id);
      await auditAgent(request, user, "agent.delete", { id: params.data.id });
      return reply.code(204).send();
    });
  }

  function registerLoginRoutes(api: FastifyInstance, login: LoginFlow) {
    const authRateLimit = { max: 20, timeWindow: "1 minute" };
    const baseCookie = {
      httpOnly: true,
      secure: cookieSecure,
      path: "/",
    } as const;

    function failLogin(reply: FastifyReply) {
      reply.clearCookie(cookies.login, baseCookie);
      return reply.redirect(`${appOrigin}/?auth_error=access_denied`, 302);
    }

    api.get(
      "/auth/login",
      { config: { public: true, rateLimit: authRateLimit } },
      async (request, reply) => {
        kit.privateResponse(reply);
        // Langue de l'interface relayée à Keycloak (liste fermée).
        const locale = z.object({ locale: z.enum(["fr", "en"]).optional() }).safeParse(request.query);
        const { authorizationUrl, transaction } = await login.oidc.startLogin(
          locale.success && locale.data.locale ? { locale: locale.data.locale } : {},
        );

        reply.setCookie(cookies.login, login.transactions.encode(transaction), {
          ...baseCookie,
          // Lax : le cookie doit revenir sur la redirection depuis Keycloak.
          sameSite: "lax",
          maxAge: LoginTransactionCodec.maxAgeSeconds,
        });
        return reply.redirect(authorizationUrl, 302);
      },
    );

    api.get(
      "/auth/callback",
      { config: { public: true, rateLimit: authRateLimit } },
      async (request, reply) => {
        kit.privateResponse(reply);
        const transaction = login.transactions.decode(request.cookies[cookies.login]);

        if (!transaction) {
          await audit.record(request, {
            eventType: "auth.login",
            outcome: "failure",
            details: { reason: "invalid_transaction" },
          });
          return failLogin(reply);
        }

        const query = request.raw.url?.split("?")[1] ?? "";
        const callbackUrl = new URL(`${appOrigin}/api/auth/callback?${query}`);

        let completed;
        try {
          completed = await login.oidc.completeLogin(callbackUrl, transaction);
        } catch (error) {
          request.log.warn({ err: error }, "Échec du callback OIDC");
          await audit.record(request, {
            eventType: "auth.login",
            outcome: "failure",
            details: { reason: "oidc_validation_failed" },
          });
          return failLogin(reply);
        }

        // Pas de provisioning ouvert : identité déjà rattachée, invitation en
        // attente pour l'e-mail vérifié, ou organisation SSO liée.
        let userId = await login.directory.findUserId(login.issuer, completed.subject);
        if (login.provision) {
          const provisioned = await login.provision({
            issuer: login.issuer,
            subject: completed.subject,
            email: completed.profile.email,
            emailVerified: completed.emailVerified,
            ssoAliases: completed.organizations,
          });
          userId = provisioned.userId;
          if (provisioned.joined > 0 && userId) {
            await audit.record(request, {
              eventType: "auth.provisioned",
              outcome: "success",
              actorUserId: userId,
              details: { organizations: provisioned.joined, sso: completed.organizations.length > 0 },
            });
          }
        }
        if (!userId) {
          await audit.record(request, {
            eventType: "auth.login",
            outcome: "denied",
            details: { reason: "unknown_identity" },
          });
          return failLogin(reply);
        }

        // Anti-fixation : toute session existante est révoquée.
        await login.sessions.revoke(request.cookies[cookies.session]);
        const token = await login.sessions.create({
          userId,
          subject: completed.subject,
          tokens: completed.tokens,
          profile: completed.profile,
          idpSessionId: completed.sessionId,
        });

        await audit.record(request, {
          eventType: "auth.login",
          outcome: "success",
          actorUserId: userId,
        });

        reply.clearCookie(cookies.login, baseCookie);
        reply.setCookie(cookies.session, token, {
          ...baseCookie,
          sameSite: "strict",
          maxAge: SESSION_MAX_SECONDS,
        });
        return reply.redirect(`${appOrigin}/`, 302);
      },
    );

    api.post(
      "/auth/logout",
      { config: { public: true } },
      async (request, reply) => {
        kit.privateResponse(reply);
        const revoked = await login.sessions.revoke(request.cookies[cookies.session]);
        reply.clearCookie(cookies.session, { ...baseCookie, sameSite: "strict" });

        if (!revoked) return { logoutUrl: `${appOrigin}/` };

        await audit.record(request, {
          eventType: "auth.logout",
          outcome: "success",
          actorUserId: revoked.userId,
        });
        return { logoutUrl: await login.oidc.logoutUrl(revoked.idToken) };
      },
    );

    // OIDC Back-Channel Logout : Keycloak notifie la fin d'une session (admin,
    // déconnexion ailleurs, compte désactivé) ; la session Snowfall est fermée
    // immédiatement au lieu d'attendre la revalidation périodique.
    api.post(
      "/auth/backchannel-logout",
      { config: { public: true, csrfExempt: true, rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (request, reply) => {
        kit.privateResponse(reply);
        const token = (request.body as Record<string, unknown> | undefined)?.logout_token;
        if (typeof token !== "string" || token.length > 8_192 || !login.oidc.verifyLogoutToken) {
          return reply.code(400).send({ error: "invalid_request" });
        }

        const target = await login.oidc.verifyLogoutToken(token);
        if (!target) {
          await audit.record(request, {
            eventType: "auth.backchannel_logout",
            outcome: "denied",
            details: { reason: "invalid_logout_token" },
          });
          return reply.code(400).send({ error: "invalid_request" });
        }

        const users = await login.sessions.revokeIdpSession(target);
        for (const userId of new Set(users)) {
          await audit.record(request, {
            eventType: "auth.backchannel_logout",
            outcome: "success",
            actorUserId: userId,
            details: { sessions: users.filter((id) => id === userId).length },
          });
        }
        return reply.code(200).send();
      },
    );
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Erreur non gérée");

    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;

    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    const message =
      status !== 500 && error instanceof Error
        ? error.message
        : "Internal server error";

    return reply.code(status).send({ error: message });
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: "Not found" });
  });

  return app;
}

export function createProductionServer() {
  const config = loadConfig();
  const masterKey = parseMasterKey(config.masterKey);
  const pool = getPool();

  const oidc = new KeycloakOidcClient({
    ...config.oidc,
    appOrigin: config.appOrigin,
    allowInsecureHttp:
      config.nodeEnv !== "production" && config.oidc.issuer.startsWith("http://"),
    extraScopes: config.oidcExtraScopes,
  });
  const sessions = new PostgresSessionStore(pool, masterKey, (token, subject) =>
    oidc.refresh(token, subject),
  );
  const directory = new PostgresIdentityDirectory(pool);
  const redis = config.redisUrl
    ? new Redis(config.redisUrl, { connectTimeout: 500, maxRetriesPerRequest: 1 })
    : undefined;

  // Le logger Fastify n'existe qu'après création : l'audit est branché ensuite.
  const auditRef: { current: AuditLog } = { current: noopAuditLog };
  const metrics = createMetrics();
  // Chaque événement d'audit est aussi compté (alertes de sécurité).
  const audit: AuditLog = countingAuditLog({ record: (request, event) => auditRef.current.record(request, event) }, metrics);

  const llmLimits = {
    maxOutputTokens: config.llm.maxOutputTokens,
    timeoutMs: config.llm.timeoutMs,
  };
  const providers: Partial<Record<ProviderId, ProviderSettings>> = {};
  if (config.llm.mistralApiKey) providers.mistral = { apiKey: config.llm.mistralApiKey, ...llmLimits };
  if (config.llm.openaiApiKey) providers.openai = { apiKey: config.llm.openaiApiKey, ...llmLimits };
  if (config.llm.anthropicApiKey) providers.anthropic = { apiKey: config.llm.anthropicApiKey, ...llmLimits };
  if (config.llm.googleApiKey) {
    providers.google = { apiKey: config.llm.googleApiKey, ...llmLimits, thinkingLevel: config.llm.googleThinkingLevel };
  }
  if (config.llm.localBaseUrl) {
    providers.local = {
      apiKey: config.llm.localApiKey ?? "local",
      baseUrl: config.llm.localBaseUrl,
      tools: config.llm.localTools,
      ...llmLimits,
    };
  }

  const models = new ProviderRegistry(providers, {
    defaultSelection: config.llm.defaultSelection,
    // Modèle echo local, uniquement hors production (refusé par loadConfig).
    fallback: config.nodeEnv === "production" ? undefined : echoModel,
  });
  const keyring = new OrganizationKeyring(createKeyEncryption(config.kms, masterKey));

  // Embeddings : par fournisseur configuré ; l'organisation choisit lequel.
  const embeddingConfig: EmbeddingConfig = {};
  if (providers.mistral) embeddingConfig.mistral = { settings: providers.mistral, model: config.knowledge.embeddingModels.mistral };
  if (providers.openai) embeddingConfig.openai = { settings: providers.openai, model: config.knowledge.embeddingModels.openai };
  if (providers.google) embeddingConfig.google = { settings: providers.google, model: config.knowledge.embeddingModels.google };
  if (config.knowledge.localEmbedding && config.knowledge.embeddingModels.local) {
    embeddingConfig.local = {
      settings: { ...llmLimits, apiKey: config.knowledge.localEmbedding.apiKey, baseUrl: config.knowledge.localEmbedding.baseUrl },
      model: config.knowledge.embeddingModels.local,
    };
  }
  const embeddings = new EmbeddingRegistry(embeddingConfig);
  const scanner = config.antivirus ? new ClamdScanner(config.antivirus) : undefined;
  const settingsStore = new PostgresSettingsStore(pool);
  // Le logger n'existe qu'après création de l'application : branché par référence.
  const knowledgeLog: { current: FastifyBaseLogger | null } = { current: null };
  const ocr = config.ocrSocket ? new UnixSocketOcr(config.ocrSocket) : undefined;
  const knowledge = new KnowledgeService({
    ocr,
    store: new PostgresKnowledgeStore(pool, keyring),
    embeddings,
    settings: settingsStore,
    audit,
    log: () => knowledgeLog.current!,
    linksEnabled: config.knowledge.links,
    reranker: config.knowledge.rerank ? new HttpReranker(config.knowledge.rerank) : null,
    scanner,
    fetchProxy: config.egressProxy,
    rerankMinScore: config.knowledge.rerank?.minScore ?? 0,
    rerankCandidates: config.knowledge.rerank?.candidates ?? 10,
  });
  // Recherche web : SearXNG interne (il sort lui-même par le proxy de sortie).
  const webSearch = config.webSearchUrl ? new SearxngClient(config.webSearchUrl) : undefined;
  // Interpréteur de code : bac à sable sans réseau, par socket Unix.
  const sandbox = config.sandboxSocket ? new UnixSocketSandbox(config.sandboxSocket) : undefined;

  const app = createAppServer({
    models,
    // Exécution durable : runs et points de reprise chiffrés en base.
    runs: new PostgresRunStore(pool, keyring),
    // Compaction : résumés chiffrés, calculés par le modèle de la conversation.
    summaries: new PostgresSummaryStore(pool, keyring),
    ...(webSearch ? { webSearch } : {}),
    ...(sandbox ? { sandbox } : {}),
    // Serveurs MCP : sortie par le proxy (HTTPS_PROXY), domaines dans infra/egress/mcp-domains.txt.
    // Sans proxy (développement) : chaque nom est résolu et doit viser une adresse publique.
    ...(config.mcpEnabled
      ? { mcp: { store: new PostgresMcpServerStore(pool, keyring), ...(process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY === "1" ? {} : { checkAddress: publicAddressOnly }) } }
      : {}),
    generatedFiles: new PostgresGeneratedFileStore(pool, keyring),
    shares: new PostgresShareStore(pool, keyring),
    prompts: new PostgresPromptStore(pool, keyring),
    ...(ocr ? { ocr } : {}),
    memories: new PostgresUserMemoryStore(pool, keyring),
    agentRatings: new PostgresAgentRatingStore(pool),
    // Traces vers Langfuse auto-hébergé, si configuré.
    ...(config.tracing ? { tracer: createLangfuseTracer(config.tracing) } : {}),
    summarize: createSummarizer((selection) => models.runner(selection)),
    checkpointer: (tenant) => new EncryptedCheckpointSaver(pool, keyring, tenant),
    agents: new PostgresAgentStore(pool, keyring),
    settings: settingsStore,
    knowledge,
    embeddingProviders: () => embeddings.available(),
    rewriteQuery: createQueryRewriter((selection) => models.runner(selection)),
    agentMaxSteps: config.llm.agentMaxSteps,
    agentMaxTokens: config.llm.agentMaxTokens,
    runTiming: { maxActiveMs: config.llm.agentMaxSeconds * 1000 },
    toolUsage: settingsStore,
    ...(scanner ? { scanner } : {}),
    metrics,
    members: new PostgresMemberStore(pool),
    preferences: new PostgresPreferencesStore(pool),
    projects: new PostgresProjectStore(pool, keyring),
    attachments: new PostgresAttachmentStore(pool, keyring),
    appOrigin: config.appOrigin,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    ...(redis ? { redis } : {}),
    withDatabase: true,
    audit,
    authenticate: createSessionAuthenticator({
      cookieName: cookieNames(config.cookieSecure).session,
      sessions,
      directory,
      audit,
    }),
    conversationStore: new PostgresConversationStore(pool, keyring),
    login: {
      issuer: config.oidc.issuer,
      oidc,
      sessions,
      directory,
      transactions: new LoginTransactionCodec(masterKey),
      provision: (input) => provisionIdentity(pool, input),
    },
  });

  const sinks: AuditSink[] = [];
  if (config.audit.stdout) sinks.push(new LoggerAuditSink(app.log));
  if (config.audit.siem) sinks.push(new HttpAuditForwarder(config.audit.siem, app.log));
  auditRef.current = new FanoutAuditLog(new PostgresAuditLog(pool, app.log), sinks);
  knowledgeLog.current = app.log;
  // Conservation des traces limitée (rétention de Langfuse réservée à son édition payante).
  if (config.tracing) startTraceRetention(config.tracing, app.log);

  // Échec franc au démarrage si des migrations manquent, plutôt que des 500 plus tard.
  app.addHook("onReady", async () => {
    const drift = await findSchemaDrift(pool);
    if (drift.length > 0) {
      throw new Error(
        `Base de données non migrée (${drift.join(", ")}). Lance "npm run db:migrate" dans apps/api.`,
      );
    }
    // Imports interrompus par le dernier arrêt : repris en tâche de fond.
    knowledge.recover().catch((error: unknown) => app.log.error({ err: error }, "Reprise des imports impossible"));
  });

  app.log.info(
    {
      providers: Object.keys(providers),
      defaultModel: config.llm.defaultSelection
        ? `${config.llm.defaultSelection.provider}:${config.llm.defaultSelection.model}`
        : "echo",
      kms: config.kms.provider,
      siem: Boolean(config.audit.siem),
      embeddings: embeddings.available(),
      knowledgeLinks: config.knowledge.links,
      rerank: config.knowledge.rerank?.model ?? "off",
      antivirus: config.antivirus ? `clamav://${config.antivirus.host}:${config.antivirus.port}` : "off",
      ocr: config.ocrSocket ? "local" : "off",
    },
    "Fournisseurs LLM configurés",
  );

  const purge = setInterval(() => {
    sessions.purgeExpired().catch((error: unknown) => {
      app.log.error({ err: error }, "Échec de purge des sessions expirées");
    });
  }, 10 * 60 * 1000);
  purge.unref();

  const metricsServer = config.metrics
    ? startMetricsServer(metrics, config.metrics)
    : null;

  app.addHook("onClose", async () => {
    metricsServer?.close();
    clearInterval(purge);
    await redis?.quit();
  });

  return { app, config };
}

const entryPoint = process.argv[1];

if (
  entryPoint &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  try {
    const { app, config } = createProductionServer();
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
