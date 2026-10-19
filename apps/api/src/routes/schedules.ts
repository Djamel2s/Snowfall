import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Agent, AgentStore } from "../agents/store.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { nextRun, validTimezone, type Cadence } from "../schedules/rule.js";
import type { ScheduleStore } from "../schedules/store.js";
import type { RouteKit } from "./kit.js";

// Agents planifiés (chacun les siens) : une consigne envoyée à un agent chaque
// jour, chaque semaine, ou quand un document arrive dans sa base. Le résultat
// s'écrit dans une conversation dédiée de l'auteur.

export type ScheduleDependencies = {
  store: ScheduleStore;
  agents: AgentStore;
  /** Conversation dédiée, au nom de l'auteur, avec cet agent. */
  createConversation(user: AuthenticatedUser, title: string, agent: Agent): Promise<{ id: string }>;
};

const inputSchema = z
  .object({
    agentId: z.uuid(),
    name: z.string().trim().min(1).max(60),
    prompt: z.string().trim().min(3).max(4_000),
    kind: z.enum(["schedule", "knowledge"]),
    cadence: z.enum(["daily", "weekly"]).optional(),
    hour: z.number().int().min(0).max(23).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    timezone: z.string().min(1).max(64).refine(validTimezone),
  })
  .strict();

export function registerScheduleRoutes(api: FastifyInstance, kit: RouteKit, deps: ScheduleDependencies) {
  api.get("/me/schedules", async (request) => {
    const user = kit.principal(request);
    return { schedules: await deps.store.list(user) };
  });

  api.post("/me/schedules", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const input = body.data;
    let rule: Cadence | null = null;
    if (input.kind === "schedule") {
      if (input.cadence === undefined || input.hour === undefined || (input.cadence === "weekly" && input.weekday === undefined)) return reply.code(400).send({ error: "Invalid request" });
      rule = input.cadence === "daily" ? { cadence: "daily", hour: input.hour } : { cadence: "weekly", hour: input.hour, weekday: input.weekday! };
    }
    // Un agent de l'organisation, que l'auteur peut utiliser.
    const agent = await deps.agents.get(user, input.agentId);
    if (!agent) return reply.code(404).send({ error: "Not found" });
    if (input.kind === "knowledge" && !agent.tools.includes("search_knowledge")) return reply.code(400).send({ error: "Invalid request", reason: "no_knowledge" });
    if ((await deps.store.list(user)).length >= 5) return reply.code(409).send({ error: "Conflict", reason: "schedule_limit" });

    const conversation = await deps.createConversation(user, input.name, agent);
    const created = await deps.store.create(user, {
      agentId: agent.id,
      conversationId: conversation.id,
      name: input.name,
      prompt: input.prompt,
      kind: input.kind,
      rule,
      timezone: input.timezone,
      nextRunAt: rule ? nextRun(rule, input.timezone, new Date()) : null,
    });
    if (!created) return reply.code(409).send({ error: "Conflict", reason: "schedule_limit" });
    await kit.record(request, user, { eventType: "agent.schedule_create", targetType: "agent", targetId: agent.id, details: { kind: input.kind, cadence: rule?.cadence ?? "trigger" } });
    return reply.code(201).send({ schedule: created });
  });

  api.patch("/me/schedules/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    const body = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const current = await deps.store.get(user, params.data.id);
    if (!current) return reply.code(404).send({ error: "Not found" });
    // Réactivée : la prochaine échéance repart de maintenant (pas de rattrapage en rafale).
    const next = body.data.enabled && current.rule ? nextRun(current.rule, current.timezone, new Date()) : null;
    const updated = await deps.store.setEnabled(user, params.data.id, body.data.enabled, next);
    return { schedule: updated };
  });

  api.post("/me/schedules/:id/run", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await deps.store.runSoon(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    return reply.code(202).send({ ok: true });
  });

  api.delete("/me/schedules/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await deps.store.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "agent.schedule_delete", targetType: "agent_schedule", targetId: params.data.id });
    return reply.code(204).send();
  });
}
