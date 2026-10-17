import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { createChatRunner, type ChatChunk, type ChatModel, type ChatRequest, type ToolEvent } from "../graph/chat-graph.js";
import { defineTool, runTool, toolSpec } from "./tools.js";

/**
 * Modèle scripté : chaque appel joue l'étape suivante du scénario. On garde
 * les requêtes reçues pour vérifier ce que la boucle lui a vraiment envoyé.
 */
function scripted(steps: ((request: ChatRequest) => ChatChunk[])[]) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    id: "scripted",
    supportsTools: true,
    async *stream(request) {
      requests.push(structuredClone(request));
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      for (const chunk of step(request)) yield chunk;
    },
  };
  return { model, requests };
}

const call = (id: string, name: string, args: unknown): ChatChunk => ({ type: "tool_call", call: { id, name, arguments: args } });

const weather = defineTool({
  name: "weather",
  description: "Météo d'une ville.",
  parameters: z.object({ city: z.string().min(2) }).strict(),
  access: "read",
  execute: async ({ city }) => ({ content: `Il fait 18 °C à ${city}.`, summary: city }),
});

describe("Boucle d'agent", () => {
  it("le modèle demande un outil, la boucle l'exécute et lui renvoie le résultat", async () => {
    const { model, requests } = scripted([
      () => [{ type: "token", text: "Je regarde. " }, call("c1", "weather", { city: "Lyon" }), { type: "usage", inputTokens: 100, outputTokens: 10 }],
      () => [{ type: "token", text: "18 °C à Lyon." }, { type: "usage", inputTokens: 150, outputTokens: 5 }],
    ]);
    const events: ToolEvent[] = [];
    const tokens: string[] = [];
    const result = await createChatRunner(model)(
      { message: "Quel temps à Lyon ?", tools: [weather] },
      { onTool: (event) => events.push(event), onToken: (text) => tokens.push(text) },
    );

    assert.equal(result.content, "Je regarde. \n\n18 °C à Lyon.");
    assert.equal(result.steps, 1);
    assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 15 });
    // Deuxième appel : la transcription contient l'appel puis son résultat.
    assert.deepEqual(requests[1]!.turns!.slice(1), [
      { role: "assistant", content: "Je regarde. ", toolCalls: [{ id: "c1", name: "weather", arguments: { city: "Lyon" } }] },
      { role: "tool", toolCallId: "c1", name: "weather", content: "Il fait 18 °C à Lyon." },
    ]);
    assert.deepEqual(events.map((event) => event.status), ["running", "done"]);
    assert.equal(events[1]!.summary, "Lyon");
    assert.deepEqual(requests[0]!.tools, [toolSpec(weather)]);
  });

  it("des arguments invalides reviennent au modèle comme une erreur qu'il peut corriger", async () => {
    const { model, requests } = scripted([
      () => [call("c1", "weather", { ville: "Lyon" })],
      () => [call("c2", "weather", { city: "Lyon" })],
      () => [{ type: "token", text: "18 °C." }],
    ]);
    const result = await createChatRunner(model)({ message: "Météo ?", tools: [weather] });

    const errorTurn = requests[1]!.turns!.at(-1)!;
    assert.equal(errorTurn.role, "tool");
    assert.ok(errorTurn.role === "tool" && errorTurn.isError && /Arguments invalides/.test(errorTurn.content));
    assert.equal(result.steps, 2);
    assert.equal(result.content, "18 °C.");
  });

  it("outil inconnu ou en échec : erreur générique, jamais de détail interne", async () => {
    const broken = defineTool({
      name: "broken",
      description: "Échoue.",
      parameters: z.object({}).strict(),
      access: "read",
      execute: async () => {
        throw new Error("mot de passe de la base : hunter2");
      },
    });
    const signal = new AbortController().signal;
    assert.deepEqual(await runTool([broken], { name: "inexistant", arguments: {} }, signal), { content: "Outil inconnu : inexistant.", isError: true });
    const failed = await runTool([broken], { name: "broken", arguments: {} }, signal);
    assert.equal(failed.isError, true);
    assert.ok(!failed.content.includes("hunter2"));
  });

  it("au-delà du nombre d'étapes, le modèle est rappelé sans outils et doit conclure", async () => {
    const { model, requests } = scripted([
      (request) => (request.tools ? [call(`c${Math.random()}`, "weather", { city: "Lyon" })] : [{ type: "token", text: "Voici ce que j'ai." }]),
    ]);
    const result = await createChatRunner(model)({ message: "Boucle !", tools: [weather], maxSteps: 3 });

    assert.equal(result.steps, 3);
    assert.equal(requests.length, 4);
    assert.ok(requests.slice(0, 3).every((request) => request.tools));
    assert.equal(requests[3]!.tools, undefined);
    assert.equal(result.content, "Voici ce que j'ai.");
  });

  it("budget de tokens dépassé : plus d'outils, le modèle conclut (coût d'une réponse borné)", async () => {
    let n = 0;
    const { model, requests } = scripted([
      (request) =>
        request.tools
          ? [call(`c${++n}`, "weather", { city: "Lyon" }), { type: "usage", inputTokens: 3_000, outputTokens: 100 }]
          : [{ type: "token", text: "Je conclus." }, { type: "usage", inputTokens: 3_000, outputTokens: 50 }],
    ]);
    const result = await createChatRunner(model)({ message: "Boucle !", tools: [weather], maxSteps: 10, maxTokens: 5_000 });
    // 2 appels avec outils (3 100 puis 6 200 tokens), puis conclusion sans outils.
    assert.deepEqual(requests.map((request) => Boolean(request.tools)), [true, true, false]);
    assert.equal(result.content, "Je conclus.");
  });

  it("exécute les appels d'une étape en parallèle, en refusant l'excès", async () => {
    let running = 0;
    let peak = 0;
    const slow = defineTool({
      name: "slow",
      description: "Lent.",
      parameters: z.object({ n: z.number() }).strict(),
      access: "read",
      execute: async ({ n }) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running--;
        return { content: `ok ${n}` };
      },
    });
    const { model, requests } = scripted([
      () => Array.from({ length: 10 }, (_, n) => call(`c${n}`, "slow", { n })),
      () => [{ type: "token", text: "fini" }],
    ]);
    await createChatRunner(model)({ message: "x", tools: [slow] });

    const results = requests[1]!.turns!.filter((turn) => turn.role === "tool");
    assert.equal(results.length, 10);
    assert.equal(peak, 8);
    assert.equal(results.filter((turn) => turn.role === "tool" && turn.isError).length, 2);
  });

  it("un modèle sans appels d'outils ne reçoit pas d'outils", async () => {
    const seen: ChatRequest[] = [];
    const model: ChatModel = {
      id: "simple",
      async *stream(request) {
        seen.push(request);
        yield { type: "token", text: "ok" };
      },
    };
    await createChatRunner(model)({ message: "x", tools: [weather] });
    assert.equal(seen[0]!.tools, undefined);
  });

  it("l'annulation interrompt aussi un outil en cours", async () => {
    const controller = new AbortController();
    const hanging = defineTool({
      name: "hanging",
      description: "Ne répond pas.",
      parameters: z.object({}).strict(),
      access: "read",
      execute: (_args, { signal }) =>
        new Promise((_resolve, reject) => {
          controller.abort();
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const { model } = scripted([() => [call("c1", "hanging", {})], () => [{ type: "token", text: "jamais" }]]);
    await assert.rejects(createChatRunner(model)({ message: "x", tools: [hanging] }, { signal: controller.signal }));
  });
});
