import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";
import type { ChatChunk, ChatTurn } from "../graph/chat-graph.js";
import { toAnthropicMessages, toAnthropicTools } from "./anthropic.js";
import { createGoogleModel, toGeminiContents } from "./google.js";
import { toMistralMessages } from "./mistral.js";
import { createOpenAiCompatibleModel, toOpenAiMessages } from "./openai.js";

// Une même transcription neutre, traduite dans le format de chaque fournisseur.
const transcript: ChatTurn[] = [
  { role: "user", content: "Météo à Lyon et Paris ?" },
  {
    role: "assistant",
    content: "Je regarde.",
    toolCalls: [
      { id: "c1", name: "weather", arguments: { city: "Lyon" }, providerData: { thoughtSignature: "sig-123" } },
      { id: "c2", name: "weather", arguments: { city: "Paris" } },
    ],
  },
  { role: "tool", toolCallId: "c1", name: "weather", content: "18 °C" },
  { role: "tool", toolCallId: "c2", name: "weather", content: "Service indisponible", isError: true },
];

async function collect(stream: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("Formats d'appels d'outils par fournisseur", () => {
  it("Anthropic : tool_use dans la réponse, tool_result regroupés dans un message utilisateur", () => {
    const messages = toAnthropicMessages(transcript);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "Je regarde." },
        { type: "tool_use", id: "c1", name: "weather", input: { city: "Lyon" } },
        { type: "tool_use", id: "c2", name: "weather", input: { city: "Paris" } },
      ],
    });
    assert.deepEqual(messages[2], {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "18 °C" },
        { type: "tool_result", tool_use_id: "c2", content: "Service indisponible", is_error: true },
      ],
    });
    assert.deepEqual(toAnthropicTools([{ name: "weather", description: "Météo", parameters: { type: "object" } }]), [
      { name: "weather", description: "Météo", input_schema: { type: "object" } },
    ]);
  });

  it("OpenAI : tool_calls en JSON texte, un message « tool » par résultat", () => {
    const messages = toOpenAiMessages(transcript);
    assert.deepEqual(messages[1], {
      role: "assistant",
      content: "Je regarde.",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"Lyon"}' } },
        { id: "c2", type: "function", function: { name: "weather", arguments: '{"city":"Paris"}' } },
      ],
    });
    assert.deepEqual(messages.slice(2), [
      { role: "tool", tool_call_id: "c1", content: "18 °C" },
      { role: "tool", tool_call_id: "c2", content: "[erreur] Service indisponible" },
    ]);
  });

  it("Gemini : functionCall avec sa signature de raisonnement, functionResponse regroupées", () => {
    const contents = toGeminiContents(transcript);
    assert.deepEqual(contents[1], {
      role: "model",
      parts: [
        { text: "Je regarde." },
        { functionCall: { id: "c1", name: "weather", args: { city: "Lyon" } }, thoughtSignature: "sig-123" },
        { functionCall: { id: "c2", name: "weather", args: { city: "Paris" } } },
      ],
    });
    assert.deepEqual(contents[2], {
      role: "user",
      parts: [
        { functionResponse: { id: "c1", name: "weather", response: { content: "18 °C" } } },
        { functionResponse: { id: "c2", name: "weather", response: { error: "Service indisponible" } } },
      ],
    });
  });

  it("Mistral (LangChain) : AIMessage avec tool_calls, puis ToolMessage", () => {
    const messages = toMistralMessages(transcript);
    assert.deepEqual(messages.map((message) => message.getType()), ["human", "ai", "tool", "tool"]);
    const ai = messages[1] as unknown as { tool_calls: { id: string; args: unknown }[] };
    assert.deepEqual(ai.tool_calls.map((call) => [call.id, call.args]), [["c1", { city: "Lyon" }], ["c2", { city: "Paris" }]]);
  });
});

describe("Flux d'appels d'outils", () => {
  // Serveur compatible OpenAI qui découpe l'appel d'outil en fragments,
  // comme le font OpenAI, vLLM et Ollama.
  let server: Server;
  let port = 0;
  let body: { tools?: unknown[]; messages: unknown[] } | undefined;
  before(async () => {
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk));
      request.on("end", () => {
        body = JSON.parse(raw);
        const events = [
          { choices: [{ delta: { content: "Je cherche. " } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "search_knowledge", arguments: '{"que' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"congés"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "search_knowledge", arguments: "{cassé" } }] } }] },
          { choices: [], usage: { prompt_tokens: 30, completion_tokens: 12 } },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("OpenAI/local : reconstitue les arguments fragmentés, garde le JSON invalide tel quel", async () => {
    const model = createOpenAiCompatibleModel(
      "local",
      "llama",
      { apiKey: "x", baseUrl: `http://127.0.0.1:${port}/v1`, maxOutputTokens: 100, timeoutMs: 5_000 },
      { tools: true },
    );
    assert.equal(model.supportsTools, true);
    const chunks = await collect(
      model.stream({ history: [], message: "x", tools: [{ name: "search_knowledge", description: "d", parameters: { type: "object" } }] }),
    );
    assert.deepEqual(chunks, [
      { type: "token", text: "Je cherche. " },
      { type: "usage", inputTokens: 30, outputTokens: 12 },
      { type: "tool_call", call: { id: "call_a", name: "search_knowledge", arguments: { query: "congés" } } },
      { type: "tool_call", call: { id: "call_b", name: "search_knowledge", arguments: "{cassé" } },
    ]);
    assert.equal(body?.tools?.length, 1);
  });

  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("Gemini : functionCall diffusé avec sa signature, outils en schéma JSON complet", async () => {
    let sent: { tools?: { functionDeclarations: { parametersJsonSchema: unknown }[] }[] } | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      const event = { candidates: [{ content: { parts: [{ functionCall: { name: "weather", args: { city: "Lyon" } }, thoughtSignature: "sig" }] } }] };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200 });
    }) as typeof fetch;

    const chunks = await collect(
      createGoogleModel("gemini-3-flash", { apiKey: "k", maxOutputTokens: 100, timeoutMs: 5_000 }).stream({
        history: [],
        message: "Météo ?",
        tools: [{ name: "weather", description: "Météo", parameters: { type: "object", additionalProperties: false } }],
      }),
    );
    assert.deepEqual(chunks, [
      { type: "tool_call", call: { id: "call_1", name: "weather", arguments: { city: "Lyon" }, providerData: { thoughtSignature: "sig" } } },
    ]);
    assert.deepEqual(sent?.tools?.[0]?.functionDeclarations[0]?.parametersJsonSchema, { type: "object", additionalProperties: false });
  });
});
