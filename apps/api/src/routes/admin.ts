import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AdminForbiddenError, OVERVIEW_PERIODS, type AdminOverviewStore } from "../admin/overview.js";
import type { AgentRating, AgentRatingStore } from "../agents/ratings.js";
import type { AgentStore } from "../agents/store.js";
import type { MemberStore } from "../workspace/members.js";
import type { SettingsStore } from "../workspace/settings.js";
import type { RouteKit } from "./kit.js";

// Administration › Pilotage : adoption, usage des agents, consommation. Des
// totaux seulement (voir admin/overview.ts) ; administrateurs seulement, refus
// journalisé. Le rôle est vérifié ici ET dans la fonction SQL.

export type AdminDependencies = {
  overview: AdminOverviewStore;
  members: MemberStore;
  agents?: AgentStore | undefined;
  ratings?: AgentRatingStore | undefined;
  settings?: SettingsStore | undefined;
};

const query = z.object({ days: z.coerce.number().int().refine((days) => (OVERVIEW_PERIODS as readonly number[]).includes(days)).default(30) }).strict();

export function registerAdminRoutes(api: FastifyInstance, kit: RouteKit, deps: AdminDependencies) {
  api.get("/admin/overview", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const denied = async () => {
      await kit.record(request, user, { eventType: "admin.overview", outcome: "denied", details: { role: user.role } });
      return reply.code(403).send({ error: "Forbidden" });
    };
    if (!kit.isAdmin(user)) return denied();
    const parsed = query.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid period" });

    let data;
    try {
      data = await deps.overview.overview(user, parsed.data.days);
    } catch (error) {
      if (error instanceof AdminForbiddenError) return denied();
      throw error;
    }
    const [members, agents, ratings, settings] = await Promise.all([
      deps.members.list(user),
      deps.agents ? deps.agents.list(user) : [],
      deps.ratings ? deps.ratings.ratings(user).catch(() => ({}) as Record<string, AgentRating>) : ({} as Record<string, AgentRating>),
      deps.settings?.get(user),
    ]);
    // Agent non visible de l'administrateur (privé, supprimé) : compté, sans nom.
    const names = new Map(agents.map((agent) => [agent.id, agent.name]));
    return {
      days: parsed.data.days,
      members: { total: members.length, active7: data.active7, active30: data.active30, activePeriod: data.activePeriod },
      activity: data.days,
      agents: data.agents.map((agent) => ({ ...agent, name: names.get(agent.agentId) ?? null, ...(ratings[agent.agentId] ? { rating: ratings[agent.agentId] } : {}) })),
      tokens: data.tokens,
      monthlyTokenLimit: settings?.monthlyTokenLimit ?? null,
      tools: data.tools,
    };
  });
}
