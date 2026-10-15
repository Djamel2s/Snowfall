import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
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
  type ChatRunner,
  type ChatTurn,
  type ModelImage,
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
  /** Remplace le routage par modèle (tests). */
  runChat?: ChatRunner;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const HISTORY_TURNS = 20;

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
  const createConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    agentId: z.uuid().optional(),
    projectId: z.uuid().optional(),
  }).strict();

  const updateConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
    projectId: z.uuid().nullable().optional(),
  }).strict().refine((body) => body.title !== undefined || body.projectId !== undefined);

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

  /**
   * Contrôle avant génération : fournisseur autorisé par l'organisation et
   * plafonds de tokens. Répond directement en cas de refus.
   */
  async function admitGeneration(
    request: FastifyRequest,
    reply: FastifyReply,
    user: AuthenticatedUser,
    agent: Agent | null,
  ): Promise<{ provider: ProviderId | "echo" } | null> {
    const provider = models.providerFor(agent ? { provider: agent.provider, model: agent.model } : undefined);
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

  /**
   * Génération diffusée en Server-Sent Events : "token" à chaque fragment,
   * puis "done" (messages enregistrés) ou "error". Si le client arrête la
   * génération, la réponse partielle est enregistrée et comptée.
   */
  function streamGeneration(options: {
    request: FastifyRequest;
    reply: FastifyReply;
    user: AuthenticatedUser;
    conversationId: string;
    agent: Agent | null;
    provider: ProviderId | "echo";
    input: { history: ChatTurn[]; message: string; images: ModelImage[] };
    eventType: string;
    details: Record<string, string | number | boolean>;
    persist: (content: string) => Promise<Record<string, unknown> | null>;
  }) {
    const { request, reply, user, agent, input } = options;
    const runChat = runnerFor(agent ? { provider: agent.provider, model: agent.model } : undefined);

    const stream = new PassThrough();
    const send = (event: "token" | "done" | "error", data: unknown) => {
      stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const generation = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) generation.abort();
    });

    const inputChars =
      input.message.length + input.history.reduce((total, turn) => total + turn.content.length, 0);
    let partial = "";

    const finish = async (content: string, usage: UsageTotals | undefined, model: string, partialAnswer: boolean) => {
      const payload = await options.persist(content);
      if (!payload) return null;

      // Le fournisseur ne compte pas toujours (arrêt, echo) : estimation prudente.
      const counted = usage ?? { inputTokens: estimateTokens("x".repeat(inputChars)), outputTokens: estimateTokens(content) };
      await deps.settings?.record(user, options.provider, counted).catch((error: unknown) => {
        request.log.error({ err: error }, "Échec d'enregistrement de la consommation");
      });
      await kit.record(request, user, {
        eventType: options.eventType,
        targetType: "conversation",
        targetId: options.conversationId,
        details: {
          ...options.details,
          agentId: agent?.id ?? "",
          model,
          inputTokens: counted.inputTokens,
          outputTokens: counted.outputTokens,
          partial: partialAnswer,
        },
      });
      return payload;
    };

    void (async () => {
      try {
        const result = await runChat(
          { message: input.message, history: input.history, images: input.images, instructions: agent?.instructions },
          {
            signal: generation.signal,
            onToken: (text) => {
              partial += text;
              send("token", { text });
            },
          },
        );

        const payload = await finish(result.content, result.usage, result.model, false);
        if (!payload) {
          send("error", { error: "Not found" });
          return;
        }
        send("done", payload);
      } catch (error) {
        if (generation.signal.aborted) {
          request.log.info("Génération interrompue par le client");
          if (partial.trim()) {
            await finish(partial, undefined, options.provider, true).catch((cause: unknown) => {
              request.log.error({ err: cause }, "Échec d'enregistrement de la réponse partielle");
            });
          }
        } else {
          request.log.error({ err: error }, "Échec du graphe de chat");
          send("error", {
            error: error instanceof ModelRefusalError
              ? "Refused"
              : error instanceof ProviderUnavailableError
                ? "Provider unavailable"
                : "Assistant unavailable",
          });
        }
      } finally {
        stream.end();
      }
    })();

    reply.header("Content-Type", "text/event-stream; charset=utf-8");
    reply.header("X-Accel-Buffering", "no");
    return reply.send(stream);
  }

  app.register(async (api) => {
    // Corps "application/x-www-form-urlencoded" : utilisé par Keycloak pour
    // le logout_token (back-channel), taille bornée.
    api.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16_384 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
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

      try {
        const conversation = await conversationStore.create(
          user,
          parsed.data.title,
          parsed.data.agentId,
          parsed.data.projectId,
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

      try {
        const conversation = await conversationStore.update(user, params.data.id, {
          ...(body.data.title !== undefined ? { title: body.data.title } : {}),
          ...(body.data.projectId !== undefined ? { projectId: body.data.projectId } : {}),
        });
        if (!conversation) return conversationNotFound(request, reply, user, params.data.id);

        await kit.record(request, user, {
          eventType: "conversation.update",
          targetType: "conversation",
          targetId: conversation.id,
          details: { renamed: body.data.title !== undefined, moved: body.data.projectId !== undefined },
        });
        return { conversation };
      } catch (error) {
        if (error instanceof Error && error.message === "PROJECT_NOT_FOUND") {
          return reply.code(400).send({ error: "Invalid request" });
        }
        throw error;
      }
    });

    api.get("/models", async (request, reply) => {
      kit.privateResponse(reply);
      const [catalog, allowed] = await Promise.all([models.catalog(), allowedProviders(kit.principal(request))]);
      return {
        providers: catalog.map((provider) => ({ ...provider, allowed: allowed.includes(provider.id) })),
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
    });

    if (deps.attachments) registerAttachmentRoutes(api, kit, deps.attachments);

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
      return { conversation, history, agent };
    }

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
      const { history, agent } = loaded;

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

      const admitted = await admitGeneration(request, reply, user, agent);
      if (!admitted) return reply;

      const context = prior.slice(-HISTORY_TURNS);
      const files = await modelFiles(user, params.data.id, context, attachmentIds);

      return streamGeneration({
        request,
        reply,
        user,
        conversationId: params.data.id,
        agent,
        provider: admitted.provider,
        input: buildModelInput(context, { content, attachmentIds }, files),
        eventType: "message.create",
        details: { attachments: attachmentIds.length, edited: Boolean(editMessageId) },
        persist: async (answer) => {
          const exchange = await conversationStore.appendExchange(user, params.data.id, content, answer, {
            attachmentIds,
            ...(editMessageId ? { replaceFromMessageId: editMessageId } : {}),
          });
          return exchange ? { userMessage: exchange.userMessage, assistantMessage: exchange.assistantMessage } : null;
        },
      });
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
      const { history, agent } = loaded;

      // Seule la dernière réponse se régénère, à partir de la question qui la précède.
      const last = history.at(-1);
      const question = history.at(-2);
      if (last?.role !== "assistant" || question?.role !== "user") {
        return reply.code(400).send({ error: "Invalid request" });
      }

      const admitted = await admitGeneration(request, reply, user, agent);
      if (!admitted) return reply;

      const context = history.slice(0, -2).slice(-HISTORY_TURNS);
      const attachmentIds = question.attachments?.map((file) => file.id) ?? [];
      const files = await modelFiles(user, params.data.id, context, attachmentIds);

      return streamGeneration({
        request,
        reply,
        user,
        conversationId: params.data.id,
        agent,
        provider: admitted.provider,
        input: buildModelInput(context, { content: question.content, attachmentIds }, files),
        eventType: "message.regenerate",
        details: { attachments: attachmentIds.length },
        persist: async (answer) => {
          const assistantMessage = await conversationStore.replaceLastAssistant(user, params.data.id, last.id, answer);
          return assistantMessage ? { assistantMessage } : null;
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
      const [allowed, permitted] = await Promise.all([
        models.isAllowed({ provider: parsed.data.provider, model: parsed.data.model }),
        allowedProviders(user),
      ]);
      return allowed && permitted.includes(parsed.data.provider) ? parsed.data : null;
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
        ...(agent.provider ? { details: { provider: agent.provider, model: agent.model ?? "" } } : {}),
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
  const audit: AuditLog = { record: (request, event) => auditRef.current.record(request, event) };

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
      ...llmLimits,
    };
  }

  const models = new ProviderRegistry(providers, {
    defaultSelection: config.llm.defaultSelection,
    // Modèle echo local, uniquement hors production (refusé par loadConfig).
    fallback: config.nodeEnv === "production" ? undefined : echoModel,
  });
  const keyring = new OrganizationKeyring(createKeyEncryption(config.kms, masterKey));

  const app = createAppServer({
    models,
    agents: new PostgresAgentStore(pool, keyring),
    settings: new PostgresSettingsStore(pool),
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

  // Échec franc au démarrage si des migrations manquent, plutôt que des 500 plus tard.
  app.addHook("onReady", async () => {
    const drift = await findSchemaDrift(pool);
    if (drift.length > 0) {
      throw new Error(
        `Base de données non migrée (${drift.join(", ")}). Lance "npm run db:migrate" dans apps/api.`,
      );
    }
  });

  app.log.info(
    {
      providers: Object.keys(providers),
      defaultModel: config.llm.defaultSelection
        ? `${config.llm.defaultSelection.provider}:${config.llm.defaultSelection.model}`
        : "echo",
      kms: config.kms.provider,
      siem: Boolean(config.audit.siem),
    },
    "Fournisseurs LLM configurés",
  );

  const purge = setInterval(() => {
    sessions.purgeExpired().catch((error: unknown) => {
      app.log.error({ err: error }, "Échec de purge des sessions expirées");
    });
  }, 10 * 60 * 1000);
  purge.unref();

  app.addHook("onClose", async () => {
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
