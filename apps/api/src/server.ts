import Fastify from "fastify";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { runChatGraph } from "./graph/chat-graph.js";
import databasePlugin from "./plugins/database.js";
import {
  authenticateWithKeycloak,
  type AuthenticatedUser,
  type Authenticator,
} from "./auth/auth.js";
import { z } from "zod";
import { getPool } from "./db/pool.js";
import {
  PostgresConversationStore,
  type ConversationStore,
} from "./conversations/store.js";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

export function createAppServer(
  options: {
    withDatabase?: boolean;
    authenticate?: Authenticator;
    conversationStore?: ConversationStore;
    runChat?: typeof runChatGraph;
  } = {},
) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 1_048_576,
  });
  
  app.register(helmet);
  app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
  
  const authenticate: Authenticator =
    options.authenticate ?? authenticateWithKeycloak;

  if (options.withDatabase ?? process.env.NODE_ENV !== "test") {
    app.register(databasePlugin);
  }

  const conversationStore =
    options.conversationStore ??
    new PostgresConversationStore(getPool());

  const conversationIdSchema = z.string().uuid();
  const createConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
  }).strict();

  const messageSchema = z.object({
    content: z.string().trim().min(1).max(4000),
  }).strict();

  const runChat = options.runChat ?? runChatGraph;

  function privateResponse(reply: import("fastify").FastifyReply) {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
  }

  function canWrite(user: AuthenticatedUser) {
    return user.role !== "reader";
  }

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await authenticate(request);

    if (!user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    return { user };
  });

  app.get("/conversations", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.code(401).send({ error: "Unauthorized" });

    privateResponse(reply);
    return conversationStore.list(user);
  });

  app.post("/conversations", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.code(401).send({ error: "Unauthorized" });
    privateResponse(reply);

    if (!canWrite(user)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const parsed = createConversationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request" });
    }

    try {
      const conversation = await conversationStore.create(
        user,
        parsed.data.title,
      );
      return reply.code(201).send({ conversation });
    } catch (error) {
      if (error instanceof Error && error.message === "MEMBERSHIP_REQUIRED") {
        return reply.code(403).send({ error: "Forbidden" });
      }
      throw error;
    }
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.code(401).send({ error: "Unauthorized" });
    privateResponse(reply);

    const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });

    const messages = await conversationStore.getMessages(user, params.data.id);
    if (messages === null) return reply.code(404).send({ error: "Not found" });

    return { messages };
  });

  app.delete("/conversations/:id", async (request, reply) => {
    const user = await authenticate(request);
    if (!user) return reply.code(401).send({ error: "Unauthorized" });
    privateResponse(reply);

    if (!canWrite(user)) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });

    const deleted = await conversationStore.delete(user, params.data.id);
    if (!deleted) return reply.code(404).send({ error: "Not found" });

    return reply.code(204).send();
  });

  app.post(
    "/conversations/:id/messages",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const user = await authenticate(request);
      if (!user) return reply.code(401).send({ error: "Unauthorized" });
      privateResponse(reply);

      if (!canWrite(user)) return reply.code(403).send({ error: "Forbidden" });

      const params = z.object({ id: conversationIdSchema }).safeParse(request.params);
      const body = messageSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: "Invalid request" });
      }

      const history = await conversationStore.getMessages(user, params.data.id);
      if (history === null) return reply.code(404).send({ error: "Not found" });

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
      if (!exchange) return reply.code(404).send({ error: "Not found" });

      return reply.code(201).send({
        response,
        userMessage: exchange.userMessage,
        assistantMessage: exchange.assistantMessage,
      });
    },
  );

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

const entryPoint = process.argv[1];

if (
  entryPoint &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3001);
  const app = createAppServer();

  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
