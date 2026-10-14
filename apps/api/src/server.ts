import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import { z } from "zod";
import { runChatGraph } from "./graph/chat-graph.js";
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
import { noopAuditLog, PostgresAuditLog, type AuditLog } from "./audit/audit.js";
import { loadConfig } from "./config.js";
import { LocalKeyEncryptionProvider, parseMasterKey } from "./crypto/envelope.js";
import { OrganizationKeyring } from "./crypto/keyring.js";
import { getPool } from "./db/pool.js";
import {
  PostgresConversationStore,
  type ConversationStore,
} from "./conversations/store.js";

dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

declare module "fastify" {
  interface FastifyContextConfig {
    /** Route accessible sans session. Tout le reste est refusé par défaut. */
    public?: boolean;
  }
  interface FastifyRequest {
    principal: AuthenticatedUser | null;
  }
}

export type LoginFlow = {
  issuer: string;
  oidc: OidcClient;
  sessions: SessionStore;
  directory: IdentityDirectory;
  transactions: LoginTransactionCodec;
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
  runChat?: typeof runChatGraph;
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function cookieNames(secure: boolean) {
  // Le préfixe __Host- impose Secure, Path=/ et l'absence de Domain.
  const prefix = secure ? "__Host-" : "";
  return {
    session: `${prefix}snowfall_session`,
    login: `${prefix}snowfall_login`,
  };
}

export function createAppServer(deps: AppDependencies) {
  const appOrigin = deps.appOrigin ?? "http://localhost:5173";
  const cookieSecure = deps.cookieSecure ?? false;
  const cookies = cookieNames(cookieSecure);
  const audit = deps.audit ?? noopAuditLog;
  const authenticate: Authenticator = deps.authenticate ?? (async () => null);
  const conversationStore = deps.conversationStore;
  const runChat = deps.runChat ?? runChatGraph;

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
  }).strict();

  const messageSchema = z.object({
    content: z.string().trim().min(1).max(4000),
  }).strict();

  function privateResponse(reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
  }

  function principal(request: FastifyRequest): AuthenticatedUser {
    if (!request.principal) throw new Error("PRINCIPAL_MISSING");
    return request.principal;
  }

  function canWrite(user: AuthenticatedUser) {
    return user.role !== "reader";
  }

  async function denyWrite(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser) {
    await audit.record(request, {
      eventType: "authorization.write",
      outcome: "denied",
      actorUserId: user.userId,
      organizationId: user.organizationId,
      details: { role: user.role, route: request.routeOptions.url ?? "" },
    });
    return reply.code(403).send({ error: "Forbidden" });
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

  app.register(async (api) => {
    // Protection CSRF : toute requête modifiante doit venir de notre origine.
    // Complète SameSite=Strict sur le cookie de session.
    api.addHook("onRequest", async (request, reply) => {
      if (SAFE_METHODS.has(request.method)) return;

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

    if (deps.login) {
      registerLoginRoutes(api, deps.login);
    }

    api.get("/auth/me", async (request, reply) => {
      privateResponse(reply);
      const { profile, ...user } = principal(request);
      return { user, profile: profile ?? {} };
    });

    api.get("/conversations", async (request, reply) => {
      privateResponse(reply);
      return conversationStore.list(principal(request));
    });

    api.post("/conversations", async (request, reply) => {
      const user = principal(request);
      privateResponse(reply);

      if (!canWrite(user)) return denyWrite(request, reply, user);

      const parsed = createConversationSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid request" });
      }

      try {
        const conversation = await conversationStore.create(user, parsed.data.title);
        await audit.record(request, {
          eventType: "conversation.create",
          outcome: "success",
          actorUserId: user.userId,
          organizationId: user.organizationId,
          targetType: "conversation",
          targetId: conversation.id,
        });
        return reply.code(201).send({ conversation });
      } catch (error) {
        if (error instanceof Error && error.message === "MEMBERSHIP_REQUIRED") {
          return reply.code(403).send({ error: "Forbidden" });
        }
        throw error;
      }
    });

    api.get("/conversations/:id/messages", async (request, reply) => {
      const user = principal(request);
      privateResponse(reply);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const messages = await conversationStore.getMessages(user, params.data.id);
      if (messages === null) {
        return conversationNotFound(request, reply, user, params.data.id);
      }

      return { messages };
    });

    api.delete("/conversations/:id", async (request, reply) => {
      const user = principal(request);
      privateResponse(reply);

      if (!canWrite(user)) return denyWrite(request, reply, user);

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      const deleted = await conversationStore.delete(user, params.data.id);
      if (!deleted) return conversationNotFound(request, reply, user, params.data.id);

      await audit.record(request, {
        eventType: "conversation.delete",
        outcome: "success",
        actorUserId: user.userId,
        organizationId: user.organizationId,
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
      keyGenerator: (request) => `user-messages:${principal(request).userId}`,
    });

    api.post(
      "/conversations/:id/messages",
      async (request, reply) => {
        const user = principal(request);
        privateResponse(reply);

        const limit = await checkUserMessageLimit(request);
        if (!limit.isAllowed && limit.isExceeded) {
          reply.header("Retry-After", Math.ceil(limit.ttl / 1000));
          return reply.code(429).send({ error: "Too many requests" });
        }

        if (!canWrite(user)) return denyWrite(request, reply, user);

        const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
        const body = messageSchema.safeParse(request.body);
        if (!params.success || !body.success) {
          return reply.code(400).send({ error: "Invalid request" });
        }

        const history = await conversationStore.getMessages(user, params.data.id);
        if (history === null) {
          return conversationNotFound(request, reply, user, params.data.id);
        }

        let response: string;
        try {
          response = await runChat({
            message: body.data.content,
            history: history.slice(-20),
          });
        } catch (error) {
          request.log.error({ err: error }, "Échec du graphe de chat");
          return reply.code(502).send({ error: "Assistant unavailable" });
        }

        const exchange = await conversationStore.appendExchange(
          user,
          params.data.id,
          body.data.content,
          response,
        );
        if (!exchange) return conversationNotFound(request, reply, user, params.data.id);

        await audit.record(request, {
          eventType: "message.create",
          outcome: "success",
          actorUserId: user.userId,
          organizationId: user.organizationId,
          targetType: "conversation",
          targetId: params.data.id,
        });

        return reply.code(201).send({
          response,
          userMessage: exchange.userMessage,
          assistantMessage: exchange.assistantMessage,
        });
      },
    );
  });

  function registerLoginRoutes(
    api: import("fastify").FastifyInstance,
    login: LoginFlow,
  ) {
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
      async (_request, reply) => {
        privateResponse(reply);
        const { authorizationUrl, transaction } = await login.oidc.startLogin();

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
        privateResponse(reply);
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

        // Pas de provisioning automatique : l'identité doit être rattachée.
        const userId = await login.directory.findUserId(login.issuer, completed.subject);
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
        privateResponse(reply);
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

  const app = createAppServer({
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
    conversationStore: new PostgresConversationStore(
      pool,
      new OrganizationKeyring(new LocalKeyEncryptionProvider(masterKey)),
    ),
    login: {
      issuer: config.oidc.issuer,
      oidc,
      sessions,
      directory,
      transactions: new LoginTransactionCodec(masterKey),
    },
  });

  auditRef.current = new PostgresAuditLog(pool, app.log);

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
