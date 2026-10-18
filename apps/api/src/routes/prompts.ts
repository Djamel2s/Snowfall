import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PromptStore } from "../prompts/store.js";
import { promptVariables } from "../prompts/store.js";
import type { RouteKit } from "./kit.js";

const idParams = z.object({ id: z.uuid() });
const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    content: z.string().trim().min(1).max(8_000),
    shared: z.boolean().default(false),
  })
  .strict()
  .refine((input) => promptVariables(input.content).length <= 10);

/** Bibliothèque de prompts : audit sans contenu (ni nom, ni texte). */
export function registerPromptRoutes(api: FastifyInstance, kit: RouteKit, store: PromptStore) {
  api.get("/prompts", async (request, reply) => {
    kit.privateResponse(reply);
    return { prompts: await store.list(kit.principal(request)) };
  });

  api.post("/prompts", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const prompt = await store.create(user, body.data);
    await kit.record(request, user, { eventType: "prompt.create", targetType: "prompt", targetId: prompt.id, details: { shared: prompt.shared } });
    return reply.code(201).send({ prompt });
  });

  api.put("/prompts/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    const body = inputSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const prompt = await store.update(user, params.data.id, body.data);
    if (!prompt) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "prompt.update", targetType: "prompt", targetId: prompt.id, details: { shared: prompt.shared } });
    return { prompt };
  });

  api.delete("/prompts/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "prompt.delete", targetType: "prompt", targetId: params.data.id });
    return reply.code(204).send();
  });
}
