import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { defineTool } from "../agent/tools.js";
import { createChatRunner, type ChatChunk, type ChatModel } from "../graph/chat-graph.js";
import { createLangfuseTracer, maskPersonalData, startTraceRetention, type RunInfo } from "./tracing.js";

const settings = { baseUrl: "http://langfuse:3000", publicKey: "pk-lf-test", secretKey: "sk-lf-test" };

const info = (overrides: Partial<RunInfo> = {}): RunInfo => ({
  runId: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  organizationId: "44444444-4444-4444-8444-444444444444",
  kind: "message",
  provider: "mistral",
  model: "mistral:mistral-small-latest",
  agent: { id: "55555555-5555-4555-8555-555555555555", name: "Juriste" },
  resumed: false,
  confidential: false,
  question: "Écris à jean.dupont@exemple.fr au 06 12 34 56 78",
  ...overrides,
});

/** Agent scripté : il cherche, puis répond. */
function agentRun() {
  const model: ChatModel = {
    id: "mistral:mistral-small-latest",
    supportsTools: true,
    async *stream(request): AsyncIterable<ChatChunk> {
      if (request.turns?.at(-1)?.role === "tool") {
        yield { type: "token", text: "Votre IBAN FR76 3000 6000 0112 3456 7890 189 est noté." };
        yield { type: "usage", inputTokens: 300, outputTokens: 20, cachedInputTokens: 250 };
        return;
      }
      yield { type: "tool_call", call: { id: "c1", name: "lookup", arguments: { query: "client jean.dupont@exemple.fr" } } };
      yield { type: "usage", inputTokens: 200, outputTokens: 10 };
    },
  };
  const lookup = defineTool({
    name: "lookup",
    description: "Cherche.",
    parameters: z.object({ query: z.string() }).strict(),
    access: "read",
    execute: async () => ({ content: "Client : 1 85 05 78 006 084 36" }),
  });
  return { runner: createChatRunner(model), lookup };
}

async function traced(overrides: Partial<RunInfo> = {}, content: "masked" | "none" = "masked") {
  const exporter = new InMemorySpanExporter();
  const tracer = createLangfuseTracer({ ...settings, content }, exporter);
  const { runner, lookup } = agentRun();
  const run = tracer.startRun(info(overrides));
  const result = await runner({ message: "x", tools: [lookup] }, { trace: run });
  run.end({ status: "done", output: result.content, usage: result.usage });
  await tracer.flush();
  return exporter.getFinishedSpans();
}

const byName = (spans: ReadableSpan[], prefix: string) => spans.filter((span) => span.name.startsWith(prefix));

describe("Traces des agents (OpenTelemetry)", () => {
  it("une trace par réponse : modèle, outil, modèle ; conventions GenAI et session Langfuse", async () => {
    const spans = await traced();
    const [root] = byName(spans, "invoke_agent");
    assert.ok(root);
    assert.equal(root.name, "invoke_agent Juriste");
    const children = spans.filter((span) => span !== root);
    assert.deepEqual(children.map((span) => span.name).sort(), ["chat mistral:mistral-small-latest", "chat mistral:mistral-small-latest", "execute_tool lookup"]);
    // Tous rattachés à la même trace et à la réponse.
    assert.ok(children.every((span) => span.spanContext().traceId === root.spanContext().traceId && span.parentSpanContext?.spanId === root.spanContext().spanId));

    assert.equal(root.attributes["gen_ai.operation.name"], "invoke_agent");
    assert.equal(root.attributes["langfuse.session.id"], info().conversationId);
    assert.equal(root.attributes["gen_ai.usage.input_tokens"], 500);
    assert.equal(root.attributes["gen_ai.usage.cache_read.input_tokens"], 250);
    const tool = byName(spans, "execute_tool")[0]!;
    assert.equal(tool.attributes["gen_ai.tool.name"], "lookup");
    assert.equal(tool.attributes["snowfall.tool.status"], "done");
    const calls = byName(spans, "chat");
    assert.deepEqual(calls.map((span) => span.attributes["gen_ai.usage.output_tokens"]).sort(), [10, 20]);
  });

  it("contenu masqué : ni e-mail, ni téléphone, ni IBAN, ni numéro de sécurité sociale", async () => {
    const spans = await traced();
    const all = JSON.stringify(spans.map((span) => span.attributes));
    for (const secret of ["jean.dupont@exemple.fr", "06 12 34 56 78", "FR76 3000", "1 85 05 78"]) assert.ok(!all.includes(secret), secret);
    assert.match(all, /\[email\]/);
    assert.match(all, /\[iban\]/);
    assert.match(all, /\[nir\]/);
  });

  it("base confidentielle, ou mode « none » : aucun contenu, seulement les mesures", async () => {
    for (const spans of [await traced({ confidential: true }), await traced({}, "none")]) {
      const keys = spans.flatMap((span) => Object.keys(span.attributes));
      for (const field of ["langfuse.observation.input", "langfuse.observation.output", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) {
        assert.ok(!keys.includes(field), field);
      }
      assert.ok(keys.includes("gen_ai.usage.input_tokens"));
    }
  });

  it("le masquage garde ce qui est utile (montants, dates) et retire les secrets", () => {
    assert.equal(maskPersonalData("Solde de 148,00 € au 10/09/2026, loyer 316,00 €"), "Solde de 148,00 € au 10/09/2026, loyer 316,00 €");
    assert.equal(maskPersonalData("clé sk-proj-AbCdEfGh12345678 et Bearer abcdefghijklmnopqrstuv"), "clé [secret] et Bearer [secret]");
    assert.equal(maskPersonalData("Appelle le +33 6 12 34 56 78 depuis 10.0.0.12"), "Appelle le [téléphone] depuis [ip]");
    assert.equal(maskPersonalData("Carte 4970 1012 3456 7890"), "Carte [carte]");
  });

  it("conservation : les traces de plus de 30 jours sont effacées par l'API de Langfuse", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    let listed = 0;
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url), ...(init?.body ? { body: String(init.body) } : {}) });
      if ((init?.method ?? "GET") === "GET") {
        listed++;
        return new Response(JSON.stringify({ data: listed <= 3 ? [{ traceId: "t1" }, { traceId: "t2" }, { traceId: "t1" }] : [] }));
      }
      return new Response(JSON.stringify({ message: "ok" }));
    }) as typeof fetch;
    const retention = startTraceRetention({ ...settings, retentionDays: 30 }, { info: () => undefined, warn: () => undefined }, fetcher);
    const deleted = await retention.purge();
    retention.stop();

    assert.equal(deleted, 2);
    const query = new URL(calls[0]!.url).searchParams;
    assert.equal(new URL(calls[0]!.url).pathname, "/api/public/v2/observations");
    assert.equal(query.get("isRootObservation"), "true");
    const before = new Date(query.get("toStartTime")!);
    assert.ok(Math.abs(Date.now() - 30 * 86_400_000 - before.getTime()) < 60_000);
    assert.deepEqual(JSON.parse(calls[1]!.body!), { traceIds: ["t1", "t2"] });
    assert.equal(calls[1]!.method, "DELETE");
  });
});
