import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ModelRefusalError, type ChatChunk } from "../graph/chat-graph.js";
import { createGoogleModel, listGoogleModels } from "./google.js";

const settings = { apiKey: "test-key", maxOutputTokens: 1000, timeoutMs: 5_000 };
const realFetch = globalThis.fetch;
const calls: { url: string; init: RequestInit }[] = [];

function mockFetch(...bodies: (string | object | number)[]) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = bodies.shift()!;
    if (typeof body === "number") return new Response("détail", { status: body });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const sse = (...events: object[]) => events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");

async function collect(stream: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

describe("Google Gemini", () => {
  it("diffuse le texte, ignore le raisonnement et compte les tokens", async () => {
    mockFetch(
      sse(
        { candidates: [{ content: { parts: [{ text: "réflexion", thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: "Bon" }] } }] },
        {
          candidates: [{ content: { parts: [{ text: "jour" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 5 },
        },
      ),
    );

    const chunks = await collect(
      createGoogleModel("gemini-2.5-flash", settings).stream({
        history: [{ role: "assistant", content: "avant" }],
        message: "Salut",
        instructions: "Sois bref.",
      }),
    );

    assert.deepEqual(chunks, [
      { type: "token", text: "Bon" },
      { type: "token", text: "jour" },
      { type: "usage", inputTokens: 7, outputTokens: 7 },
    ]);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.contents[0].role, "model");
    assert.match(body.systemInstruction.parts[0].text, /Sois bref/);
  });

  it("passe la clé en en-tête, jamais dans l'URL", async () => {
    mockFetch(sse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    await collect(createGoogleModel("gemini-2.5-flash", settings).stream({ history: [], message: "x" }));

    assert.ok(!calls[0]!.url.includes("test-key"));
    assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], "test-key");
  });

  it("traduit un blocage des filtres en refus", async () => {
    mockFetch(sse({ promptFeedback: { blockReason: "SAFETY" } }));
    await assert.rejects(
      collect(createGoogleModel("gemini-2.5-flash", settings).stream({ history: [], message: "x" })),
      ModelRefusalError,
    );

    mockFetch(sse({ candidates: [{ finishReason: "PROHIBITED_CONTENT" }] }));
    await assert.rejects(
      collect(createGoogleModel("gemini-2.5-flash", settings).stream({ history: [], message: "x" })),
      ModelRefusalError,
    );
  });

  it("n'expose pas le corps des erreurs du fournisseur", async () => {
    mockFetch(400);
    await assert.rejects(
      collect(createGoogleModel("gemini-2.5-flash", settings).stream({ history: [], message: "x" })),
      (error: Error) => error.message === "GOOGLE_400",
    );
  });

  it("ne liste que les modèles de chat textuel", async () => {
    mockFetch({
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.0-flash-001", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
        { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
        { name: "models/imagen-4.0", supportedGenerationMethods: ["predict"] },
      ],
    });

    const models = await listGoogleModels(settings);
    assert.deepEqual(models.map((model) => model.id), ["gemini-2.5-pro", "gemini-2.5-flash"]);
  });
});
