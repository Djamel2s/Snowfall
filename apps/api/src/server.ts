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
} from "./graph/chat-graph.js";
import {
  ProviderRegistry,
  ProviderUnavailableError,
  type ModelRegistry,
} from "./llm/registry.js";
import { providerIds, type ModelSelection, type ProviderId, type ProviderSettings } from "./llm/types.js";
import { agentProfileSchema } from "./agents/profile.js";
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
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { EmbeddingRegistry, type EmbeddingConfig, type EmbeddingProvider } from "./knowledge/embeddings.js";
import { citationsOf, KnowledgeService, renderKnowledge, type ActiveBase, type Passage } from "./knowledge/service.js";
import { PostgresKnowledgeStore } from "./knowledge/store.js";
import { createQueryRewriter, heuristicStandalone, type QueryRewriter } from "./knowledge/rewrite.js";
import { HttpReranker } from "./knowledge/rerank.js";
import { CitationRegistry, knowledgeTool } from "./agent/knowledge-tool.js";
import { knowledgeWriteTool } from "./agent/knowledge-write-tool.js";
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
import { defaultOrganizationTools, permittedTools, type ToolId } from "./agent/catalog.js";
import type { AgentTool } from "./agent/tools.js";
import { ClamdScanner, type MalwareScanner } from "./security/antivirus.js";
import { countingAuditLog, createMetrics, startMetricsServer, type Metrics } from "./observability/metrics.js";

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
  /** Runs d'agent (exécution durable). Absent : en mémoire (développement, tests). */
  runs?: RunStore;
  /** Points de reprise du graphe, par propriétaire. Absent : en mémoire. */
  checkpointer?: (tenant: { organizationId: string; userId: string }) => BaseCheckpointSaver;
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
};

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
  }).strict().refine((body) => !(body.agentId && body.model));

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
        );
        await kit.record(request, user, {
          eventType: "conversation.create",
          targetType: "conversation",
          targetId: conversation.id,
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
      configuredProviders: async () =>
        (await models.catalog()).filter((provider) => provider.available).map((provider) => provider.id),
      ...(deps.embeddingProviders ? { embeddingProviders: deps.embeddingProviders } : {}),
    });

    if (deps.attachments) registerAttachmentRoutes(api, kit, deps.attachments, deps.scanner);
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
    ): AgentTool[] {
      if (!models.supportsTools?.(selection)) return [];
      const tools: AgentTool[] = plan.mode === "agent" ? [...plan.tools] : [];
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
      outcome: { usage?: UsageTotals | undefined; model: string; partial: boolean; steps: number },
    ) {
      const { request: input } = run;
      const payload =
        input.kind === "message"
          ? await conversationStore
              .appendExchange(user, run.conversationId, input.content, answer, {
                attachmentIds: input.attachmentIds,
                ...(input.editMessageId ? { replaceFromMessageId: input.editMessageId } : {}),
                ...(sources.length ? { sources } : {}),
              })
              .then((exchange) => (exchange ? { userMessage: exchange.userMessage, assistantMessage: exchange.assistantMessage } : null))
          : await conversationStore
              .replaceLastAssistant(user, run.conversationId, input.previousAssistantId ?? "", answer, sources.length ? sources : undefined)
              .then((assistantMessage) => (assistantMessage ? { assistantMessage } : null));
      if (!payload) return null;

      // Le fournisseur ne compte pas toujours (arrêt, echo) : estimation prudente.
      const counted = outcome.usage ?? { inputTokens: estimateTokens(input.content), outputTokens: estimateTokens(answer) };
      deps.metrics?.tokens.inc({ provider: input.provider, direction: "input" }, counted.inputTokens);
      deps.metrics?.tokens.inc({ provider: input.provider, direction: "output" }, counted.outputTokens);
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
          partial: outcome.partial,
          steps: outcome.steps,
        },
      });
      return payload;
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
      mode: { start?: { input: { history: ChatTurn[]; message: string; images: ModelImage[] }; plan: KnowledgePlan }; resume?: Record<string, boolean>; continue?: boolean },
    ) {
      const controller = new AbortController();
      let stopReason: "cancel" | "lost" | "shutdown" | null = null;
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

      let plan: KnowledgePlan = mode.start?.plan ?? { mode: "none" };
      const saver = checkpointerFor(user);
      try {
        const conversation = await conversationStore.get(user, run.conversationId);
        if (!conversation) throw new RunFailure("Not found");
        const agent = run.request.agentId && agents ? await agents.get(user, run.request.agentId) : null;
        const selection = run.request.selection;
        // Reprise : le modèle doit toujours être autorisé (l'admin a pu changer d'avis).
        if (!mode.start && selection && !(await isModelPermitted(user, selection))) throw new RunFailure("Provider unavailable");
        const permitted = await permittedFor(user, agent);

        let input = mode.start?.input ?? { history: [], message: "", images: [] };
        if (!mode.start) {
          const values = (await saver.getTuple({ configurable: { thread_id: run.id } }))?.checkpoint.channel_values as
            | { turns?: ChatTurn[]; response?: string }
            | undefined;
          if (!values) throw new RunFailure("Not found");
          // Texte déjà produit avant la pause ou la panne (l'étape en cours sera rejouée).
          progress.text = values.response ?? "";
          plan = await resumePlan(user, conversation, agent, selection, provider, values.turns ?? [], permitted);
          input = { history: [], message: "", images: [] };
        }
        const tools = agentTools(request, user, agent, selection, plan, permitted);

        const result = await runnerFor(selection)(
          {
            message: input.message,
            history: input.history,
            images: input.images,
            instructions: agent?.instructions,
            ...(tools.length ? { tools, maxSteps: deps.agentMaxSteps } : {}),
          },
          {
            signal: controller.signal,
            onToken: (text) => {
              progress.text += text;
              emit({ type: "token", text });
            },
            onTool: (event) => {
              const index = progress.steps.findIndex((step) => step.id === event.id);
              if (index === -1) progress.steps.push(event);
              else progress.steps[index] = event;
              emit({ type: "step", step: event });
            },
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
          for (const approval of result.pending) emit({ type: "approval", approval });
          emit({ type: "paused" });
          return;
        }

        observe("success");
        const sources = plan.mode === "agent" || plan.mode === "inline" ? knowledgeSources(plan, result.content) : (run.request.sources ?? []);
        const payload = await completeRun(request, user, run, result.content, sources, {
          usage: result.usage,
          model: result.model,
          partial: false,
          steps: result.steps ?? 0,
        });
        await runs.finish(user, run.id);
        await saver.deleteThread(run.id);
        emit(payload ? { type: "done", payload } : { type: "error", error: "Not found" });
      } catch (error) {
        if (controller.signal.aborted) {
          observe("aborted");
          // Arrêt demandé : réponse partielle gardée. Bail perdu ou arrêt du
          // serveur : rien n'est effacé, une instance reprendra le run.
          if (stopReason === "cancel") {
            await cancelRun(request, user, run, progress.text, plan).catch((cause: unknown) => {
              request.log.error({ err: cause }, "Échec d'enregistrement de la réponse partielle");
            });
          }
          return;
        }
        observe(error instanceof ModelRefusalError ? "refused" : isRateLimit(error) ? "rate_limited" : "error");
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
        send("snapshot", { status, text: progress.text, steps: progress.steps, approvals: progress.pending.map(approvalView) });
      const handle = (event: RunEvent) => {
        if (closed) return;
        if (event.type === "token") send("token", { text: event.text });
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
    });

    /** Lance un nouveau run et en diffuse les événements. */
    async function startRun(options: {
      request: FastifyRequest;
      reply: FastifyReply;
      user: AuthenticatedUser;
      conversationId: string;
      run: RunRequest;
      input: { history: ChatTurn[]; message: string; images: ModelImage[] };
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

    api.addHook("onReady", async () => {
      recoverRuns().catch((error: unknown) => app.log.error({ err: error }, "Reprise des runs impossible"));
    });
    const recovery = setInterval(() => {
      recoverRuns().catch((error: unknown) => app.log.error({ err: error }, "Reprise des runs impossible"));
    }, RUN_RECOVERY_MS);
    recovery.unref();
    // Arrêt du serveur : les runs locaux s'interrompent sans rien effacer ; leur
    // bail expire et ils seront repris (ici au redémarrage, ou par une autre instance).
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

      const context = prior.slice(-HISTORY_TURNS);
      const files = await modelFiles(user, params.data.id, context, attachmentIds);

      return startRun({
        request,
        reply,
        user,
        conversationId: params.data.id,
        input: knowledgeInput(plan, buildModelInput(context, { content, attachmentIds }, files)),
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

      const context = history.slice(0, -2).slice(-HISTORY_TURNS);
      const attachmentIds = question.attachments?.map((file) => file.id) ?? [];
      const files = await modelFiles(user, params.data.id, context, attachmentIds);

      return startRun({
        request,
        reply,
        user,
        conversationId: params.data.id,
        input: knowledgeInput(plan, buildModelInput(context, { content: question.content, attachmentIds }, files)),
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
      return { ...parsed.data, tools: parsed.data.tools.filter((tool) => organizationTools.includes(tool)) };
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
        ...(agent.provider ? { details: { provider: agent.provider, model: agent.model ?? "", tools: (agent.tools ?? []).join(",") } } : {}),
      });

    api.get("/agents", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      return { agents: (await store.list(user)).map((agent) => view(user, agent)) };
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
  if (config.llm.googleApiKey) providers.google = { apiKey: config.llm.googleApiKey, ...llmLimits };
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
  const knowledge = new KnowledgeService({
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

  const app = createAppServer({
    models,
    // Exécution durable : runs et points de reprise chiffrés en base.
    runs: new PostgresRunStore(pool, keyring),
    checkpointer: (tenant) => new EncryptedCheckpointSaver(pool, keyring, tenant),
    agents: new PostgresAgentStore(pool, keyring),
    settings: settingsStore,
    knowledge,
    embeddingProviders: () => embeddings.available(),
    rewriteQuery: createQueryRewriter((selection) => models.runner(selection)),
    agentMaxSteps: config.llm.agentMaxSteps,
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
