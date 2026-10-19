import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DecisionTrainer } from "../decision/client.js";
import { DECISION_TASKS, deployable, type DecisionTask, type WorkshopStore } from "../decision/workshop.js";
import type { RouteKit } from "./kit.js";

// Atelier d'entraînement (administrateurs) : exemples saisis à la main — jamais
// tirés des conversations —, entraînement local par le service de décision,
// déploiement seulement d'un modèle qui bat la référence sur la part de test.

export type DecisionDependencies = {
  store: WorkshopStore;
  /** Service de décision local ; absent : atelier en lecture seule. */
  trainer?: DecisionTrainer | undefined;
  /** Modèle actif changé : les caches de l'API sont invalidés. */
  changed(organizationId: string): void;
};

const MIN_PER_LABEL = 5;
const taskParams = z.object({ task: z.enum(Object.keys(DECISION_TASKS) as [DecisionTask]) });

export function registerDecisionRoutes(api: FastifyInstance, kit: RouteKit, deps: DecisionDependencies) {
  const training = new Set<string>();

  function admin(request: FastifyRequest, reply: FastifyReply) {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return { user, denied: kit.denyWrite(request, reply, user) };
    return { user, denied: null };
  }

  api.get("/organization/decision/:task", async (request, reply) => {
    const params = taskParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const { user, denied } = admin(request, reply);
    if (denied) return denied;
    const [examples, models] = await Promise.all([deps.store.examples(user, params.data.task), deps.store.models(user, params.data.task)]);
    return { available: Boolean(deps.trainer), labels: DECISION_TASKS[params.data.task].labels, examples, models };
  });

  api.post("/organization/decision/:task/examples", async (request, reply) => {
    const params = taskParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const labels = Object.values(DECISION_TASKS[params.data.task].labels) as [string, ...string[]];
    const body = z
      .object({ examples: z.array(z.object({ text: z.string().trim().min(2).max(4_000), label: z.enum(labels) }).strict()).min(1).max(100) })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const { user, denied } = admin(request, reply);
    if (denied) return denied;
    const created = await deps.store.addExamples(user, params.data.task, body.data.examples);
    if (!created) return reply.code(409).send({ error: "Conflict", reason: "examples_limit" });
    await kit.record(request, user, { eventType: "decision.examples_add", details: { task: params.data.task, count: created.length } });
    return reply.code(201).send({ examples: created });
  });

  api.delete("/organization/decision/:task/examples/:id", async (request, reply) => {
    const params = taskParams.extend({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const { user, denied } = admin(request, reply);
    if (denied) return denied;
    if (!(await deps.store.deleteExample(user, params.data.task, params.data.id))) return reply.code(404).send({ error: "Not found" });
    return reply.code(204).send();
  });

  /**
   * Entraîne une tête sur la part d'entraînement, la mesure sur la part de test
   * avec la référence en place (tête active, sinon Laya sans entraînement).
   * Le modèle est gardé comme candidat ; il ne sert qu'une fois activé.
   */
  api.post("/organization/decision/:task/train", async (request, reply) => {
    const params = taskParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const { user, denied } = admin(request, reply);
    if (denied) return denied;
    if (!deps.trainer) return reply.code(409).send({ error: "Conflict", reason: "decision_unavailable" });
    const task = DECISION_TASKS[params.data.task];
    const examples = await deps.store.examples(user, params.data.task);
    const part = (split: "train" | "test") => examples.filter((item) => item.split === split).map(({ text, label }) => ({ text, label }));
    const train = part("train");
    const test = part("test");
    const enough = (items: { label: string }[]) => [task.labels.positive, task.labels.negative].every((label) => items.filter((item) => item.label === label).length >= MIN_PER_LABEL);
    if (!enough(train) || !enough(test)) return reply.code(409).send({ error: "Conflict", reason: "not_enough_examples" });

    const lock = `${user.organizationId}:${params.data.task}`;
    if (training.has(lock)) return reply.code(409).send({ error: "Conflict", reason: "already_running" });
    training.add(lock);
    try {
      const active = await deps.store.activeHead(user, params.data.task);
      const result = await deps.trainer.train({
        labels: task.labels,
        train,
        test,
        baseline: active ? { kind: "head", head: active.head } : { kind: "zero_shot", instructions: task.question.instructions, options: { ...task.question.options }, threshold: task.threshold },
      });
      const metrics = { candidate: result.candidate, baseline: result.baseline, baselineKind: active ? ("head" as const) : ("zero_shot" as const), baselineVersion: active?.version ?? null, cv: result.cv, train: train.length, test: test.length };
      const model = await deps.store.addModel(user, params.data.task, { head: result.head, metrics });
      await kit.record(request, user, {
        eventType: "decision.train",
        details: { task: params.data.task, version: model.version, deployable: model.deployable, candidate: result.candidate.tp + result.candidate.tn, baseline: result.baseline.tp + result.baseline.tn, test: test.length },
      });
      return { model };
    } catch (error) {
      request.log.warn({ err: error }, "Entraînement de décision impossible");
      return reply.code(502).send({ error: "Bad gateway", reason: "training_failed" });
    } finally {
      training.delete(lock);
    }
  });

  api.post("/organization/decision/:task/models/:id/activate", async (request, reply) => {
    const params = taskParams.extend({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const { user, denied } = admin(request, reply);
    if (denied) return denied;
    const model = (await deps.store.models(user, params.data.task)).find((item) => item.id === params.data.id);
    if (!model) return reply.code(404).send({ error: "Not found" });
    // Revérifié ici : la règle ne dépend pas de ce que l'interface affiche.
    if (!deployable(model.metrics) || !(await deps.store.activate(user, params.data.task, model.id))) {
      await kit.record(request, user, { eventType: "decision.activate", outcome: "denied", details: { task: params.data.task, version: model.version } });
      return reply.code(409).send({ error: "Conflict", reason: "not_deployable" });
    }
    deps.changed(user.organizationId);
    await kit.record(request, user, { eventType: "decision.activate", details: { task: params.data.task, version: model.version } });
    return { ok: true };
  });

  api.post("/organization/decision/:task/deactivate", async (request, reply) => {
    const params = taskParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const { user, denied } = admin(request, reply);
    if (denied) return denied;
    await deps.store.deactivate(user, params.data.task);
    deps.changed(user.organizationId);
    await kit.record(request, user, { eventType: "decision.deactivate", details: { task: params.data.task } });
    return { ok: true };
  });
}
