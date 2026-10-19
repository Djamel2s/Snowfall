import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { AuthenticatedUser } from "../auth/auth.js";
import { registerDecisionRoutes } from "../routes/decision.js";
import type { RouteKit } from "../routes/kit.js";
import type { TrainInput } from "./client.js";
import { routeMessage, type DecisionEngine } from "./routing.js";
import { deployable, MemoryWorkshopStore, type DecisionHead } from "./workshop.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const admin: AuthenticatedUser = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId: ORG, role: "admin" };
const member: AuthenticatedUser = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", organizationId: ORG, role: "member" };
const head: DecisionHead = { revision: "7b928d828b7b", weights: new Array(768).fill(0), bias: 0, threshold: 0.5, labels: { positive: "complexe", negative: "simple" } };

describe("Atelier : règle de déploiement", () => {
  const c = (tp: number, fn: number, tn: number, fp: number) => ({ tp, fn, tn, fp });
  it("plus de bonnes décisions ET au moins autant de questions complexes reconnues", () => {
    assert.equal(deployable({ candidate: c(12, 0, 12, 0), baseline: c(10, 2, 12, 0) }), true);
    // Égalité : pas de déploiement (on ne change pas pour rien).
    assert.equal(deployable({ candidate: c(10, 2, 12, 0), baseline: c(10, 2, 12, 0) }), false);
    // Meilleur au total mais rate plus de questions complexes : refusé.
    assert.equal(deployable({ candidate: c(9, 3, 12, 0), baseline: c(10, 2, 9, 3) }), false);
  });
});

describe("Atelier : routes (administrateurs)", () => {
  function setup(options: { trainer?: boolean; result?: { candidate: { tp: number; fn: number; tn: number; fp: number }; baseline: { tp: number; fn: number; tn: number; fp: number } } } = {}) {
    let current = admin;
    const events: { eventType: string; outcome?: string }[] = [];
    const inputs: TrainInput[] = [];
    const changed: string[] = [];
    // Part imposée : un exemple sur trois en test, comme ~30 % en production.
    const store = new MemoryWorkshopStore((index) => (index % 3 === 2 ? "test" : "train"));
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request) => void ((request as { principal?: AuthenticatedUser }).principal = current));
    const kit: RouteKit = {
      audit: { record: async () => undefined },
      principal: (request) => (request as { principal?: AuthenticatedUser }).principal!,
      privateResponse: () => undefined,
      canWrite: () => true,
      isAdmin: (user) => user.role === "admin" || user.role === "owner",
      denyWrite: async (_request, reply) => reply.code(403).send({ error: "Forbidden" }),
      record: async (_request, _user, event) => void events.push({ eventType: event.eventType, ...(event.outcome ? { outcome: event.outcome } : {}) }),
    };
    const result = options.result ?? { candidate: { tp: 12, fn: 0, tn: 12, fp: 0 }, baseline: { tp: 10, fn: 2, tn: 12, fp: 0 } };
    registerDecisionRoutes(app, kit, {
      store,
      ...(options.trainer === false ? {} : { trainer: { train: async (input: TrainInput) => (inputs.push(input), { head, ...result, cv: 0.9 }) } }),
      changed: (organizationId) => void changed.push(organizationId),
    });
    const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
    const fill = async (count: number) => {
      const examples = Array.from({ length: count }, (_, index) => ({ text: `Exemple ${index}`, label: index % 2 ? "complexe" : "simple" }));
      return call("POST", "/organization/decision/routing/examples", { examples });
    };
    return { app, as: (user: AuthenticatedUser) => (current = user), call, fill, events, inputs, changed, store };
  }

  it("membre : ni lecture ni écriture ; étiquette inconnue refusée", async () => {
    const { as, call } = setup();
    as(member);
    assert.equal((await call("GET", "/organization/decision/routing")).statusCode, 403);
    assert.equal((await call("POST", "/organization/decision/routing/examples", { examples: [{ text: "Bonjour", label: "simple" }] })).statusCode, 403);
    as(admin);
    assert.equal((await call("POST", "/organization/decision/routing/examples", { examples: [{ text: "Bonjour", label: "pirate" }] })).statusCode, 400);
    assert.equal((await call("GET", "/organization/decision/autre")).statusCode, 400);
  });

  it("entraîner : assez d'exemples par étiquette ET par part ; candidat gardé, jamais actif d'office", async () => {
    const { call, fill, inputs } = setup();
    await fill(12);
    assert.equal((await call("POST", "/organization/decision/routing/train")).json().reason, "not_enough_examples");
    await fill(18);
    const trained = await call("POST", "/organization/decision/routing/train");
    assert.equal(trained.statusCode, 200);
    assert.equal(trained.json().model.status, "candidate");
    assert.equal(trained.json().model.deployable, true);
    // Le service reçoit les deux parts séparées, et la référence de base.
    assert.equal(inputs[0]!.baseline.kind, "zero_shot");
    const train = new Set(inputs[0]!.train.map((item) => item.text));
    assert.ok(inputs[0]!.test.every((item) => !train.has(item.text)));
    assert.equal((await call("GET", "/organization/decision/routing")).json().models[0].status, "candidate");
  });

  it("activer : seulement un modèle déployable ; l'actif devient la référence suivante", async () => {
    const worse = setup({ result: { candidate: { tp: 9, fn: 3, tn: 12, fp: 0 }, baseline: { tp: 10, fn: 2, tn: 12, fp: 0 } } });
    await worse.fill(30);
    const model = (await worse.call("POST", "/organization/decision/routing/train")).json().model;
    assert.equal(model.deployable, false);
    assert.equal((await worse.call("POST", `/organization/decision/routing/models/${model.id}/activate`)).statusCode, 409);
    assert.ok(worse.events.some((event) => event.eventType === "decision.activate" && event.outcome === "denied"));

    const better = setup();
    await better.fill(30);
    const first = (await better.call("POST", "/organization/decision/routing/train")).json().model;
    assert.equal((await better.call("POST", `/organization/decision/routing/models/${first.id}/activate`)).statusCode, 200);
    assert.deepEqual(better.changed, [ORG]);
    await better.call("POST", "/organization/decision/routing/train");
    assert.equal(better.inputs[1]!.baseline.kind, "head");
    assert.equal((await better.call("POST", "/organization/decision/routing/deactivate")).statusCode, 200);
    assert.equal(await better.store.activeHead(admin, "routing"), null);
  });

  it("sans service de décision : entraînement indisponible", async () => {
    const { call, fill } = setup({ trainer: false });
    await fill(30);
    assert.equal((await call("GET", "/organization/decision/routing")).json().available, false);
    assert.equal((await call("POST", "/organization/decision/routing/train")).json().reason, "decision_unavailable");
  });
});

describe("Routage avec une tête entraînée", () => {
  it("la tête part au service, et son choix décide (pas le seuil de base)", async () => {
    const seen: (DecisionHead | undefined)[] = [];
    const engine: DecisionEngine = { decide: async (_text, _question, _signal, used) => (seen.push(used), { choice: "complexe", probabilities: { complexe: 0.6, simple: 0.4 }, confidence: 0.6 }) };
    const routed = await routeMessage("Et demain ?", engine, { head });
    assert.deepEqual([routed.label, routed.source], ["complexe", "trained"]);
    assert.equal(seen[0], head);
    // Sans tête, 0,6 reste sous le seuil de base (0,83) : simple.
    assert.equal((await routeMessage("Et demain ?", engine)).label, "simple");
  });
});
