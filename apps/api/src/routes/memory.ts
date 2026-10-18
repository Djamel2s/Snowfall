import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MAX_MEMORY_CHARS, MemoryFullError, memoryRejection, type UserMemoryStore } from "../memory/store.js";
import type { RouteKit } from "./kit.js";

const idParams = z.object({ id: z.uuid() });
const inputSchema = z.object({ content: z.string().trim().min(3).max(MAX_MEMORY_CHARS) }).strict();

/**
 * Mémoire de l'utilisateur, visible et modifiable par lui seul. Supprimer reste
 * possible en lecture seule (ce sont ses données). Audit sans contenu.
 */
export function registerMemoryRoutes(api: FastifyInstance, kit: RouteKit, store: UserMemoryStore) {
  api.get("/me/memories", async (request, reply) => {
    kit.privateResponse(reply);
    return { memories: await store.list(kit.principal(request)) };
  });

  api.post("/me/memories", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const rejected = memoryRejection(body.data.content);
    if (rejected) return reply.code(400).send({ error: "Invalid request", reason: `memory_${rejected}` });
    try {
      const memory = await store.add(user, body.data.content);
      await kit.record(request, user, { eventType: "memory.create", targetType: "memory", targetId: memory.id, details: { size: memory.content.length, source: "user" } });
      return reply.code(201).send({ memory });
    } catch (error) {
      if (error instanceof MemoryFullError) return reply.code(409).send({ error: "Conflict", reason: "memory_full" });
      throw error;
    }
  });

  api.delete("/me/memories/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await store.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "memory.delete", targetType: "memory", targetId: params.data.id });
    return reply.code(204).send();
  });

  api.delete("/me/memories", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const count = await store.clear(user);
    await kit.record(request, user, { eventType: "memory.clear", targetType: "memory", details: { count } });
    return reply.code(204).send();
  });
}
