import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { UnixSocketDecision } from "./client.js";
import { ROUTING_TEST, ROUTING_TRAIN } from "./routing-cases.js";
import { heuristicRoute, ROUTING_COMPLEX_THRESHOLD, routeMessage, type DecisionEngine } from "./routing.js";

const engine = (complexe: number): DecisionEngine => ({ decide: async () => ({ choice: complexe >= 0.5 ? "complexe" : "simple", probabilities: { simple: 1 - complexe, complexe }, confidence: Math.max(complexe, 1 - complexe) }) });

describe("Routage : décision", () => {
  it("heuristique : pièce jointe, bloc de code, longueur ou vocabulaire d'analyse → complexe", () => {
    assert.equal(heuristicRoute("Bonjour"), "simple");
    assert.equal(heuristicRoute("Bonjour", { attachments: 1 }), "complexe");
    assert.equal(heuristicRoute("Regarde :\n```js\nx()\n```"), "complexe");
    assert.equal(heuristicRoute("a ".repeat(200)), "complexe");
    assert.equal(heuristicRoute("Compare ces deux offres"), "complexe");
  });

  it("le seuil s'applique à P(complexe), pas au choix brut du décideur", async () => {
    // Choix « complexe » à 0,6 : sous le seuil mesuré, donc simple.
    assert.equal((await routeMessage("Et demain ?", engine(0.6))).label, "simple");
    assert.equal((await routeMessage("Et demain ?", engine(ROUTING_COMPLEX_THRESHOLD))).label, "complexe");
  });

  it("panne, réponse sans probabilité ou heuristique déjà « complexe » : jamais de décision appelée à tort", async () => {
    const broken: DecisionEngine = { decide: async () => { throw new Error("down"); } };
    assert.deepEqual(await routeMessage("Bonjour", broken), { label: "simple", source: "heuristic" });
    const odd: DecisionEngine = { decide: async () => ({ choice: "simple", probabilities: {}, confidence: 1 }) };
    assert.deepEqual(await routeMessage("Bonjour", odd), { label: "simple", source: "heuristic" });
    let called = false;
    const spy: DecisionEngine = { decide: async () => ((called = true), { choice: "simple", probabilities: { complexe: 0 }, confidence: 1 }) };
    assert.equal((await routeMessage("Rédige un plan de migration", spy)).label, "complexe");
    assert.equal(called, false);
  });

  it("jeux d'entraînement et de test disjoints et équilibrés (mesure honnête)", () => {
    const train = new Set(ROUTING_TRAIN.map((item) => item.text));
    assert.ok(ROUTING_TEST.every((item) => !train.has(item.text)));
    for (const set of [ROUTING_TRAIN, ROUTING_TEST]) {
      assert.equal(set.filter((item) => item.label === "simple").length, set.length / 2);
    }
  });
});

describe("Routage : client du service local", () => {
  // Socket Unix (Linux) ou tube nommé (Windows) : même API côté Node.
  const socketPath = () => (process.platform === "win32" ? `\\\\.\\pipe\\snowfall-decision-${crypto.randomUUID()}` : join(tmpdir(), `decision-${crypto.randomUUID()}.sock`));

  async function serve(handler: Parameters<typeof createServer>[1]) {
    const path = socketPath();
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return { path, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("envoie la question et lit la décision", async (t) => {
    let body = "";
    const service = await serve((request, response) => {
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => response.end(JSON.stringify({ choice: "simple", probabilities: { simple: 0.8, complexe: 0.2 }, confidence: 0.8 })));
    });
    t.after(() => service.close());
    const decision = await new UnixSocketDecision(service.path).decide("Bonjour", { instructions: "Simple ?", options: { simple: "a", complexe: "b" } });
    assert.equal(decision.probabilities.complexe, 0.2);
    assert.deepEqual(JSON.parse(body), { text: "Bonjour", instructions: "Simple ?", options: { simple: "a", complexe: "b" } });
  });

  it("refuse une réponse en erreur, mal formée ou démesurée", async (t) => {
    const replies = [
      (response: import("node:http").ServerResponse) => ((response.statusCode = 429), response.end("{}")),
      (response: import("node:http").ServerResponse) => response.end("pas du json"),
      (response: import("node:http").ServerResponse) => response.end(JSON.stringify({ choice: 1 })),
      (response: import("node:http").ServerResponse) => response.end("x".repeat(100_000)),
    ];
    let index = 0;
    const service = await serve((_request, response) => replies[index++]!(response));
    t.after(() => service.close());
    const client = new UnixSocketDecision(service.path);
    for (let i = 0; i < replies.length; i++) {
      await assert.rejects(client.decide("Bonjour", { instructions: "Simple ?", options: { simple: "a", complexe: "b" } }));
    }
  });

  it("service absent : échec rapide (le routage se replie sur l'heuristique)", async () => {
    const client = new UnixSocketDecision(socketPath());
    assert.equal((await routeMessage("Bonjour", client)).source, "heuristic");
  });
});
