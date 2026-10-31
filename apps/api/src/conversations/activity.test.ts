import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTIVITY_MAX_STEPS, activityOf, clip } from "./activity.js";

describe("Activité d'une réponse : ce qui est gardé", () => {
  it("rien sans étape ; étape restée en cours = interrompue ; durées cohérentes seulement", () => {
    assert.equal(activityOf([], [], 1), undefined);
    const activity = activityOf(
      [
        { id: "a", name: "web_search", status: "running", startedAt: 1_000 },
        { id: "b", name: "run_code", status: "done", startedAt: 2_000, endedAt: 1_500 },
      ],
      [],
      undefined,
      5_000,
    )!;
    assert.deepEqual(activity.steps.map((step) => step.status), ["error", "done"]);
    // Fin avant le début : ignorée (jamais une durée négative).
    assert.equal(activity.steps[1]!.endedAt, undefined);
    assert.deepEqual([activity.startedAt, activity.endedAt], [1_000, 5_000]);
  });

  it("textes du modèle ou du web : une ligne, sans caractères de contrôle, bornés ; identifiants contrôlés", () => {
    assert.equal(clip("a\u0000b\nc d", 50), "a b c d");
    assert.equal(clip("x".repeat(500), 10)!.length, 10);
    const activity = activityOf(
      [
        { id: "ok", name: "web_search", status: "done", summary: `ligne\n${"y".repeat(400)}`, agent: "Juriste\r\n", found: [1, 1, -2, 2.5, 3, 5000] },
        { id: "<script>", name: "web_search", status: "done" },
        { id: "x", name: "nom invalide", status: "done" },
      ],
      [{ n: 1, sourceId: "https://a.example/", name: "A\nB", url: "https://a.example/", base: "web", excerpt: `z${"e".repeat(600)}` }],
      1,
    )!;
    assert.equal(activity.steps.length, 1);
    const [step] = activity.steps;
    assert.ok(step!.summary!.length <= 200 && !step!.summary!.includes("\n"));
    assert.equal(step!.agent, "Juriste");
    assert.deepEqual(step!.found, [1, 3]);
    assert.equal(activity.consulted[0]!.name, "A B");
    assert.ok(activity.consulted[0]!.excerpt!.length <= 280);
  });

  it("bornée : une réponse ne fait pas grossir sans fin ce qui est enregistré", () => {
    const steps = Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, name: "web_search", status: "done" }));
    assert.equal(activityOf(steps, [], 1)!.steps.length, ACTIVITY_MAX_STEPS);
  });
});
