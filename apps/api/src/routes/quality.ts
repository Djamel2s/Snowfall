import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Agent, AgentStore } from "../agents/store.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { improve, MAX_INSTRUCTIONS, type QualityModels } from "../quality/improve.js";
import type { QualityScore, QualityStore } from "../quality/store.js";
import type { RouteKit } from "./kit.js";

// Qualité d'un agent (auteur ou administrateur) : cas d'évaluation, versions
// des instructions avec leur score, et amélioration mesurée. Une proposition
// n'est jamais appliquée sans l'auteur, et seulement si elle bat la version
// en place sans régression.

export type QualityDependencies = {
  store: QualityStore;
  agents: AgentStore;
  canManage(user: AuthenticatedUser, agent: Agent): boolean;
  /** Modèles pour mesurer cet agent (réponse en lecture seule, juge) ; sinon la raison du refus. */
  models(request: FastifyRequest, user: AuthenticatedUser, agent: Agent): Promise<{ models: QualityModels; judge: string } | { refused: "confidential" | "quota" | "unavailable" }>;
};

/** Une amélioration dure au plus 10 minutes ; une proposition se garde 30 minutes. */
const IMPROVE_TIMEOUT_MS = 10 * 60 * 1000;
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MIN_CASES = 2;

const idParams = z.object({ id: z.uuid() });
const caseParams = z.object({ id: z.uuid(), caseId: z.uuid() });
const versionParams = z.object({ id: z.uuid(), versionId: z.uuid() });
const rubricSchema = z.string().trim().min(5).max(500);

type Proposal = { agentId: string; organizationId: string; userId: string; instructions: string; score: QualityScore; baseInstructions: string; expiresAt: number };

export function registerQualityRoutes(api: FastifyInstance, kit: RouteKit, deps: QualityDependencies) {
  // Propositions en attente de décision : en mémoire (une instance) ; perdue → relancer.
  const proposals = new Map<string, Proposal>();
  const running = new Set<string>();

  async function managed(request: FastifyRequest, reply: FastifyReply, id: string) {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const agent = await deps.agents.get(user, id);
    if (!agent) {
      await reply.code(404).send({ error: "Not found" });
      return null;
    }
    if (!deps.canManage(user, agent)) {
      await kit.denyWrite(request, reply, user);
      return null;
    }
    return { user, agent };
  }

  /** Nouvelle version d'instructions appliquée à l'agent (amélioration ou restauration). */
  async function apply(user: AuthenticatedUser, agent: Agent, instructions: string, source: "improvement" | "restore", score: QualityScore | null) {
    const updated = await deps.agents.update(user, agent.id, {
      name: agent.name,
      avatar: agent.avatar,
      instructions,
      tools: agent.tools,
      mcpServers: agent.mcpServers,
      delegates: agent.delegates,
      parameters: agent.parameters,
      provider: agent.provider,
      model: agent.model,
    });
    if (!updated) return null;
    const version = await deps.store.addVersion(user, agent.id, { instructions, source, score });
    return { agent: updated, version };
  }

  api.get("/agents/:id/quality", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await managed(request, reply, params.data.id);
    if (!found) return reply;
    const [versions, cases] = await Promise.all([deps.store.versions(found.user, found.agent.id), deps.store.cases(found.user, found.agent.id)]);
    return { versions, cases };
  });

  api.post("/agents/:id/quality/cases", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = z.object({ question: z.string().trim().min(3).max(2_000), rubric: rubricSchema }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await managed(request, reply, params.data.id);
    if (!found) return reply;
    const created = await deps.store.addCase(found.user, found.agent.id, { origin: "manual", question: body.data.question, rubric: body.data.rubric });
    if (!created) return reply.code(409).send({ error: "Conflict", reason: "case_limit" });
    await kit.record(request, found.user, { eventType: "agent.eval_case_add", targetType: "agent", targetId: found.agent.id, details: { origin: "manual" } });
    return reply.code(201).send({ case: created });
  });

  // Valider un cas proposé (ou changer son critère).
  api.put("/agents/:id/quality/cases/:caseId", async (request, reply) => {
    const params = caseParams.safeParse(request.params);
    const body = z.object({ rubric: rubricSchema }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await managed(request, reply, params.data.id);
    if (!found) return reply;
    const updated = await deps.store.activateCase(found.user, found.agent.id, params.data.caseId, body.data.rubric);
    if (!updated) return reply.code(404).send({ error: "Not found" });
    return { case: updated };
  });

  api.delete("/agents/:id/quality/cases/:caseId", async (request, reply) => {
    const params = caseParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await managed(request, reply, params.data.id);
    if (!found) return reply;
    if (!(await deps.store.deleteCase(found.user, found.agent.id, params.data.caseId))) return reply.code(404).send({ error: "Not found" });
    return reply.code(204).send();
  });

  /**
   * Amélioration (flux SSE) : "progress" {phase, done, total}, puis "result" ou
   * "error". Fermer la connexion arrête tout (plus aucun appel facturé).
   */
  api.post("/agents/:id/quality/improve", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await managed(request, reply, params.data.id);
    if (!found) return reply;
    const { user, agent } = found;

    const cases = (await deps.store.cases(user, agent.id)).filter((item) => item.status === "active" && item.rubric);
    if (cases.length < MIN_CASES) return reply.code(409).send({ error: "Conflict", reason: "not_enough_cases" });
    const lock = `${user.organizationId}:${agent.id}`;
    if (running.has(lock)) return reply.code(409).send({ error: "Conflict", reason: "already_running" });
    const access = await deps.models(request, user, agent);
    if ("refused" in access) {
      await kit.record(request, user, { eventType: "agent.improve", outcome: "denied", targetType: "agent", targetId: agent.id, details: { reason: access.refused } });
      return reply.code(access.refused === "quota" ? 429 : 409).send({ error: "Conflict", reason: access.refused });
    }

    running.add(lock);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMPROVE_TIMEOUT_MS);
    const stream = new PassThrough();
    const send = (event: string, data: unknown) => stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    reply.raw.on("close", () => controller.abort());
    const scored = cases.map((item) => ({ id: item.id, question: item.question, rubric: item.rubric! }));

    void (async () => {
      try {
        const outcome = await improve(agent.instructions, scored, access.models, controller.signal, (phase, done, total) => send("progress", { phase, done, total }));
        // Score de la version en place (créée si l'agent n'a pas encore d'historique).
        const latest = (await deps.store.versions(user, agent.id))[0];
        if (latest && latest.instructions === agent.instructions) await deps.store.setScore(user, agent.id, latest.id, outcome.before.score);
        else await deps.store.addVersion(user, agent.id, { instructions: agent.instructions, source: "edit", score: outcome.before.score });

        const verdicts = (evaluation: typeof outcome.before) => Object.fromEntries(evaluation.verdicts.map((verdict) => [verdict.id, { passed: verdict.passed, reason: verdict.reason }]));
        let proposalId: string | undefined;
        if (outcome.kind === "proposed") {
          proposalId = randomUUID();
          for (const [id, proposal] of proposals) if (proposal.expiresAt < Date.now()) proposals.delete(id);
          proposals.set(proposalId, { agentId: agent.id, organizationId: user.organizationId, userId: user.userId, instructions: outcome.instructions, score: outcome.after.score, baseInstructions: agent.instructions, expiresAt: Date.now() + PROPOSAL_TTL_MS });
        }
        await kit.record(request, user, {
          eventType: "agent.improve",
          targetType: "agent",
          targetId: agent.id,
          details: { outcome: outcome.kind, before: outcome.before.score.passed, ...("after" in outcome ? { after: outcome.after.score.passed } : {}), total: outcome.before.score.total, judge: access.judge },
        });
        send("result", {
          kind: outcome.kind,
          judge: access.judge,
          before: { score: outcome.before.score, cases: verdicts(outcome.before) },
          ...("after" in outcome ? { after: { score: outcome.after.score, cases: verdicts(outcome.after) }, heldOut: outcome.heldOut } : {}),
          ...(outcome.kind === "proposed" ? { proposalId, instructions: outcome.instructions } : {}),
          ...(outcome.kind === "rejected" ? { regressions: outcome.regressions } : {}),
        });
      } catch (error) {
        const reason = controller.signal.aborted ? "aborted" : error instanceof Error && /QUOTA|LIMIT/.test(error.message) ? "quota" : "failed";
        request.log.warn({ err: error }, "Amélioration d'agent interrompue");
        send("error", { reason });
      } finally {
        clearTimeout(timer);
        running.delete(lock);
        stream.end();
      }
    })();

    reply.header("Content-Type", "text/event-stream; charset=utf-8");
    reply.header("X-Accel-Buffering", "no");
    return reply.send(stream);
  });

  // Appliquer une proposition mesurée : seulement celle que le serveur a mesurée,
  // pour cet agent, et si personne n'a changé les instructions entre-temps.
  api.post("/agents/:id/quality/apply", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = z.object({ proposalId: z.uuid() }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await managed(request, reply, params.data.id);
    if (!found) return reply;
    const proposal = proposals.get(body.data.proposalId);
    if (!proposal || proposal.expiresAt < Date.now() || proposal.agentId !== found.agent.id || proposal.organizationId !== found.user.organizationId) {
      return reply.code(410).send({ error: "Gone", reason: "proposal_expired" });
    }
    if (proposal.baseInstructions !== found.agent.instructions) return reply.code(409).send({ error: "Conflict", reason: "agent_changed" });
    if (proposal.instructions.length > MAX_INSTRUCTIONS) return reply.code(400).send({ error: "Invalid request" });
    proposals.delete(body.data.proposalId);
    const applied = await apply(found.user, found.agent, proposal.instructions, "improvement", proposal.score);
    if (!applied) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, found.user, { eventType: "agent.version_apply", targetType: "agent", targetId: found.agent.id, details: { source: "improvement", version: applied.version?.version ?? 0, passed: proposal.score.passed, total: proposal.score.total } });
    return { agent: { id: applied.agent.id, instructions: applied.agent.instructions }, version: applied.version };
  });

  api.post("/agents/:id/quality/versions/:versionId/restore", async (request, reply) => {
    const params = versionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const found = await managed(request, reply, params.data.id);
    if (!found) return reply;
    const version = await deps.store.version(found.user, found.agent.id, params.data.versionId);
    if (!version) return reply.code(404).send({ error: "Not found" });
    if (version.instructions === found.agent.instructions) return reply.code(409).send({ error: "Conflict", reason: "already_current" });
    const applied = await apply(found.user, found.agent, version.instructions, "restore", version.score);
    if (!applied) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, found.user, { eventType: "agent.version_apply", targetType: "agent", targetId: found.agent.id, details: { source: "restore", from: version.version, version: applied.version?.version ?? 0 } });
    return { agent: { id: applied.agent.id, instructions: applied.agent.instructions }, version: applied.version };
  });
}
