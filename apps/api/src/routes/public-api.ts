import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentStore } from "../agents/store.js";
import { MAX_KEY_AGENTS, MAX_KEY_DAYS, type ApiKeyPrincipal, type ApiKeyStore } from "../apikeys/store.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { ConversationStore } from "../conversations/store.js";
import type { RouteKit } from "./kit.js";

// API Snowfall (/v1) : une application tierce appelle les agents de l'organisation
// avec une clé. Chaque message passe par la MÊME route que l'interface (quotas,
// routage, règle de deux, audit) au nom de l'administrateur qui a créé la clé.
// Une écriture demandée par l'agent n'est jamais validée par l'API : elle attend
// une personne, dans Snowfall (réponse 202 « needs_approval »).

export type SseEvent = { event: string; data: unknown };

export type PublicApiDependencies = {
  keys: ApiKeyStore;
  agents: AgentStore;
  conversations: ConversationStore;
  /** Envoie un message par la route des messages, au nom de l'utilisateur ; renvoie ses événements. */
  send: (user: AuthenticatedUser, conversationId: string, content: string) => Promise<{ status: number; body: unknown; events: SseEvent[] }>;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Clé d'API de la requête (routes /v1). */
    apiKey?: ApiKeyPrincipal;
  }
}

const idParams = z.object({ id: z.uuid() });
const messageSchema = z
  .object({
    content: z.string().trim().min(1).max(20_000),
    conversation_id: z.uuid().optional(),
  })
  .strict();
const createKeySchema = z.union([
  z
    .object({
      kind: z.literal("api").optional(),
      name: z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u),
      agentIds: z.array(z.uuid()).min(1).max(MAX_KEY_AGENTS),
      expiresInDays: z.number().int().min(1).max(MAX_KEY_DAYS),
    })
    .strict(),
  // Clé SCIM : provisionnement des comptes, aucun agent.
  z
    .object({
      kind: z.literal("scim"),
      name: z.string().trim().min(1).max(60).regex(/^[^\p{Cc}]+$/u),
      expiresInDays: z.number().int().min(1).max(MAX_KEY_DAYS),
    })
    .strict(),
]);

/** Événements d'un flux SSE (« event: … » / « data: … »). */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\n\n+/)) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (!event) continue;
    try {
      events.push({ event, data: data ? JSON.parse(data) : null });
    } catch {
      events.push({ event, data: null });
    }
  }
  return events;
}

/** Ce qu'une application reçoit d'un message : jamais plus que ce que voit l'utilisateur. */
function messageView(message: { id: string; content: string; sources?: unknown; createdAt?: string } | undefined) {
  if (!message) return null;
  return { id: message.id, content: message.content, ...(message.sources ? { sources: message.sources } : {}), ...(message.createdAt ? { created_at: message.createdAt } : {}) };
}

export function registerPublicApiRoutes(api: FastifyInstance, kit: RouteKit, deps: PublicApiDependencies) {
  const v1 = { config: { apiKey: true, csrfExempt: true } } as const;

  // Par clé : 60 appels par minute (en plus des quotas de l'organisation).
  const checkKeyLimit = api.createRateLimit({ max: 60, timeWindow: "1 minute", keyGenerator: (request) => `api-key:${request.apiKey?.keyId ?? request.ip}` });

  async function allowed(request: FastifyRequest) {
    const principal = request.apiKey!;
    const ids = await deps.keys.agentsFor(principal);
    return new Set(ids ?? []);
  }

  const record = (request: FastifyRequest, status: number, details: Record<string, string | number | boolean> = {}) =>
    kit.record(request, kit.principal(request), {
      eventType: "api.request",
      ...(status >= 400 ? { outcome: status === 401 || status === 403 || status === 404 ? ("denied" as const) : ("failure" as const) } : {}),
      targetType: "api_key",
      targetId: request.apiKey!.keyId,
      details: { route: request.routeOptions.url ?? "", status, ...details },
    });

  api.get("/v1/agents", v1, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const limit = await checkKeyLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    const permitted = await allowed(request);
    const agents = (await deps.agents.list(user)).filter((agent) => permitted.has(agent.id));
    await record(request, 200, { agents: agents.length });
    return { agents: agents.map((agent) => ({ id: agent.id, name: agent.name })) };
  });

  api.post("/v1/agents/:id/messages", v1, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const limit = await checkKeyLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    const params = idParams.safeParse(request.params);
    const body = messageSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });

    // L'agent doit être listé sur la clé ET visible de son créateur.
    const permitted = await allowed(request);
    const agent = permitted.has(params.data.id) ? await deps.agents.get(user, params.data.id) : null;
    if (!agent) {
      await record(request, 404, { reason: "agent" });
      return reply.code(404).send({ error: "Not found" });
    }
    // Suite d'une conversation : la sienne, avec CET agent ; sinon une nouvelle.
    let conversationId = body.data.conversation_id;
    if (conversationId) {
      const conversation = await deps.conversations.get(user, conversationId);
      if (!conversation || conversation.agentId !== agent.id) {
        await record(request, 404, { reason: "conversation" });
        return reply.code(404).send({ error: "Not found" });
      }
    } else {
      conversationId = (await deps.conversations.create(user, undefined, agent.id)).id;
    }

    const result = await deps.send(user, conversationId, body.data.content);
    if (result.status !== 200) {
      // Refus de la route des messages (quota, modèle non autorisé, réponse en cours…) : transmis tel quel.
      await record(request, result.status);
      return reply.code(result.status).send(result.body ?? { error: "Request failed" });
    }
    const last = [...result.events].reverse().find((item) => item.event === "done" || item.event === "paused" || item.event === "error");
    if (last?.event === "done") {
      const payload = last.data as { assistantMessage?: { id: string; content: string; sources?: unknown; createdAt?: string } };
      await record(request, 200, { agentId: agent.id });
      return { conversation_id: conversationId, status: "completed", message: messageView(payload.assistantMessage) };
    }
    if (last?.event === "paused") {
      // Écriture demandée : une personne valide dans Snowfall, jamais l'application.
      const approvals = result.events.filter((item) => item.event === "approval").map((item) => {
        const approval = item.data as { tool?: string; title?: string };
        return { tool: approval.tool ?? "", title: approval.title ?? "" };
      });
      await record(request, 202, { agentId: agent.id, approvals: approvals.length });
      return reply.code(202).send({ conversation_id: conversationId, status: "needs_approval", approvals });
    }
    await record(request, 502, { agentId: agent.id });
    return reply.code(502).send({ error: "Answer failed" });
  });

  // Suite d'une conversation (après une validation dans Snowfall, par exemple).
  api.get("/v1/conversations/:id", v1, async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const limit = await checkKeyLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const permitted = await allowed(request);
    const conversation = await deps.conversations.get(user, params.data.id);
    // Seulement une conversation avec un agent permis à la clé.
    if (!conversation?.agentId || !permitted.has(conversation.agentId)) {
      await record(request, 404, { reason: "conversation" });
      return reply.code(404).send({ error: "Not found" });
    }
    const messages = (await deps.conversations.getMessages(user, conversation.id)) ?? [];
    await record(request, 200);
    return {
      conversation_id: conversation.id,
      agent_id: conversation.agentId,
      messages: messages.map((message) => ({ role: message.role, ...messageView(message) })),
    };
  });

  // ---- Gestion des clés (interface, administrateurs) ----------------------------

  api.get("/organization/api-keys", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    return { keys: await deps.keys.list(user) };
  });

  api.post("/organization/api-keys", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const body = createKeySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const kind = body.data.kind ?? "api";
    // Seulement des agents que l'administrateur voit lui-même.
    const visible = new Set((await deps.agents.list(user)).map((agent) => agent.id));
    const agentIds = "agentIds" in body.data ? [...new Set(body.data.agentIds)] : [];
    if (agentIds.some((id) => !visible.has(id))) return reply.code(400).send({ error: "Invalid request", reason: "unknown_agent" });
    const created = await deps.keys.create(user, { kind, name: body.data.name, agentIds, expiresAt: new Date(Date.now() + body.data.expiresInDays * 86_400_000) });
    if (!created) return kit.denyWrite(request, reply, user);
    await kit.record(request, user, {
      eventType: "api_key.create",
      targetType: "api_key",
      targetId: created.record.id,
      details: { kind, agents: agentIds.length, days: body.data.expiresInDays, prefix: created.record.prefix },
    });
    // La clé complète : cette fois-ci seulement.
    return reply.code(201).send({ key: created.key, record: created.record });
  });

  api.delete("/organization/api-keys/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await deps.keys.revoke(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "api_key.revoke", targetType: "api_key", targetId: params.data.id });
    return reply.code(204).send();
  });
}
