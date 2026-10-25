import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { Agent, AgentStore } from "../agents/store.js";
import type { PromptStore } from "../prompts/store.js";
import type { SkillStore } from "../skills/store.js";
import { MAX_GRANTS, SharingRuleError, type Grant, type ResourceType, type SharingStore } from "../sharing/store.js";
import type { RouteKit } from "./kit.js";

const idParams = z.object({ id: z.uuid() });
const principalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("group"), id: z.uuid() }).strict(),
  z.object({ type: z.literal("organization") }).strict(),
]);
const grantsSchema = z
  .object({ grants: z.array(z.object({ principal: principalSchema, permission: z.enum(["view", "edit"]) }).strict()).max(MAX_GRANTS) })
  .strict();
const groupName = z.string().trim().min(1).max(60);

type Deps = {
  sharing: SharingStore;
  agents?: AgentStore | undefined;
  prompts: PromptStore;
  skills?: SkillStore | undefined;
  /** Partager ou supprimer un agent : son auteur ou un administrateur. */
  canManageAgent: (user: AuthenticatedUser, agent: Agent) => boolean;
};

/** Audit sans noms ni identités : le type de ressource et la forme du partage. */
const shape = (grants: Grant[]) => ({
  grants: grants.length,
  organization: grants.some((grant) => grant.principal.type === "organization"),
  editors: grants.filter((grant) => grant.permission === "edit").length,
});

export function registerSharingRoutes(api: FastifyInstance, kit: RouteKit, deps: Deps) {
  const { sharing } = deps;

  const ruleError = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof SharingRuleError)) throw error;
    if (error.code === "FORBIDDEN") return reply.code(403).send({ error: "Forbidden" });
    return reply.code(400).send({ error: "Invalid request", reason: error.code === "LIMIT" ? "sharing_limit" : "unknown_principal" });
  };

  /** Ressource que l'utilisateur peut partager, ou réponse déjà envoyée. */
  async function shareable(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser, type: ResourceType, id: string) {
    if (type === "agent") {
      const agent = deps.agents ? await deps.agents.get(user, id) : null;
      if (!agent) return reply.code(404).send({ error: "Not found" }), false;
      if (!deps.canManageAgent(user, agent)) return kit.denyWrite(request, reply, user), false;
      return true;
    }
    if (type === "skill") {
      // Compétence : seul son auteur la partage.
      const skill = deps.skills ? await deps.skills.get(user, id) : null;
      if (!skill) return reply.code(404).send({ error: "Not found" }), false;
      if (!skill.mine) return kit.denyWrite(request, reply, user), false;
      return true;
    }
    // Prompt : seul son auteur le partage (un administrateur ne voit pas les prompts privés).
    const prompt = (await deps.prompts.list(user)).find((item) => item.id === id);
    if (!prompt) return reply.code(404).send({ error: "Not found" }), false;
    if (!prompt.mine) return kit.denyWrite(request, reply, user), false;
    return true;
  }

  for (const type of ["agent", "prompt", "skill"] as const) {
    api.get(`/${type}s/:id/access`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      if (!(await shareable(request, reply, user, type, params.data.id))) return reply;
      return { grants: await sharing.grants(user, type, params.data.id) };
    });

    api.put(`/${type}s/:id/access`, async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);
      const params = idParams.safeParse(request.params);
      const body = grantsSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
      if (!(await shareable(request, reply, user, type, params.data.id))) return reply;
      try {
        const grants = await sharing.setGrants(user, type, params.data.id, body.data.grants);
        await kit.record(request, user, { eventType: "access.update", targetType: type, targetId: params.data.id, details: shape(grants) });
        return { grants };
      } catch (error) {
        return ruleError(reply, error);
      }
    });
  }

  // Annuaire pour choisir avec qui partager : membres et groupes de l'organisation.
  api.get("/sharing/directory", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const [members, groups] = await Promise.all([sharing.directory(user), sharing.groups(user)]);
    return { members, groups: groups.map((group) => ({ id: group.id, name: group.name, memberCount: group.memberIds.length })) };
  });

  // Groupes : gérés par les administrateurs (la RLS l'impose aussi).
  api.get("/groups", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });
    return { groups: await sharing.groups(user) };
  });

  api.post("/groups", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const body = z.object({ name: groupName }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    try {
      const group = await sharing.createGroup(user, body.data.name);
      await kit.record(request, user, { eventType: "group.create", targetType: "group", targetId: group.id });
      return reply.code(201).send({ group });
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  api.put("/groups/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    const body = z
      .object({ name: groupName.optional(), memberIds: z.array(z.uuid()).max(500).optional() })
      .strict()
      .refine((value) => value.name !== undefined || value.memberIds !== undefined)
      .safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    try {
      const group = await sharing.updateGroup(user, params.data.id, {
        ...(body.data.name !== undefined ? { name: body.data.name } : {}),
        ...(body.data.memberIds ? { memberIds: body.data.memberIds } : {}),
      });
      if (!group) return reply.code(404).send({ error: "Not found" });
      await kit.record(request, user, { eventType: "group.update", targetType: "group", targetId: group.id, details: { renamed: body.data.name !== undefined, members: group.memberIds.length } });
      return { group };
    } catch (error) {
      return ruleError(reply, error);
    }
  });

  api.delete("/groups/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await sharing.deleteGroup(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "group.delete", targetType: "group", targetId: params.data.id });
    return reply.code(204).send();
  });
}
