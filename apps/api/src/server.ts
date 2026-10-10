import Fastify from "fastify";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { chatRequestSchema } from "./schemas/chat.js";
import { runChatGraph } from "./graph/chat-graph.js";
import databasePlugin from "./plugins/database.js";

dotenv.config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

export function createAppServer(options: { withDatabase? : boolean } = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 1_048_576,
  });

  if (options.withDatabase ?? process.env.NODE_ENV !== "test") {
    app.register(databasePlugin);
  }

  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.post("/chat", async (request, reply) => {
    const result = chatRequestSchema.safeParse(request.body);

    if (!result.success) {
      return reply.code(400).send({
        error: "Invalid request",
        details: result.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    }

    const response = await runChatGraph(result.data.message);
    return reply.code(200).send({
      response,
    });
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
