import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { runTool } from "../agent/tools.js";
import { OpenApiClient, OpenApiError, parseOpenApi } from "./openapi.js";
import { approvedSnapshot, mcpToolsFor } from "./tools.js";

const spec = {
  openapi: "3.1.0",
  info: { title: "Tickets", version: "1" },
  paths: {
    "/tickets/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Numéro du ticket" }],
      get: { operationId: "getTicket", summary: "Lire un ticket", parameters: [{ name: "fields", in: "query", schema: { type: "string" } }] },
    },
    "/tickets": {
      post: {
        operationId: "createTicket",
        summary: "Créer un ticket",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewTicket" } } } },
      },
    },
    "/admin": { get: { operationId: "adminOnly", parameters: [{ name: "X-Admin", in: "header", required: true, schema: { type: "string" } }] } },
  },
  components: { schemas: { NewTicket: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } },
};

/** Fausse API : enregistre chaque requête reçue. */
async function fakeApi() {
  const received: { method: string; url: string; authorization?: string; body: string }[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ method: request.method!, url: request.url!, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), body });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, url: request.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("Connecteur OpenAPI", () => {
  it("opérations lues depuis la spécification : références internes suivies, en-tête obligatoire non proposable", () => {
    const operations = parseOpenApi(spec);
    assert.deepEqual(operations.map((operation) => [operation.name, operation.method]), [["getTicket", "get"], ["createTicket", "post"], ["adminOnly", "get"]]);
    const create = operations.find((operation) => operation.name === "createTicket")!;
    assert.deepEqual((create.definition.inputSchema.properties as Record<string, unknown>).body, { type: "object", properties: { title: { type: "string" } }, required: ["title"] });
    assert.equal(operations.find((operation) => operation.name === "getTicket")!.definition.readOnlyHint, true);
    assert.equal(operations.find((operation) => operation.name === "adminOnly")!.definition.inputSchema.type, "unsupported");
  });

  it("refuse une spécification qui n'est pas OpenAPI 3, ou qui pointe vers une référence externe", () => {
    assert.throws(() => parseOpenApi({ swagger: "2.0", paths: {} }), OpenApiError);
    assert.throws(() => parseOpenApi({ openapi: "3.0.0", paths: { "/x": { get: { responses: { "200": { $ref: "https://evil.example/schema.json" } } } } } }), OpenApiError);
  });

  it("un paramètre ne peut ni changer d'hôte ni sortir du chemin : il est encodé", async () => {
    const api = await fakeApi();
    try {
      const client = new OpenApiClient({ url: api.base, token: "org-token" }, spec);
      const result = await client.callTool("getTicket", { id: "../../admin?x=@evil.example", fields: "title" });
      assert.equal(result.isError, false);
      assert.equal(api.received[0]!.url, "/api/v2/tickets/..%2F..%2Fadmin%3Fx%3D%40evil.example?fields=title");
      assert.equal(api.received[0]!.authorization, "Bearer org-token");
      await assert.rejects(client.callTool("getTicket", {}));
    } finally {
      await api.close();
    }
  });

  it("chaîne complète : outil approuvé en lecture exécuté, écriture soumise à validation, résultat marqué", async () => {
    const api = await fakeApi();
    try {
      const definitions = parseOpenApi(spec);
      const server = {
        id: "0f0f0f0f-0000-4000-8000-000000000001",
        name: "Tickets",
        url: api.base,
        kind: "openapi" as const,
        auth: "token" as const,
        hasToken: true,
        token: "org-token",
        spec,
        status: "approved" as const,
        tools: [approvedSnapshot(definitions[0]!.definition, "read"), approvedSnapshot(definitions[1]!.definition, "write")],
        updatedAt: "",
      };
      const events = { changed: () => undefined, unavailable: () => undefined, called: () => undefined };
      const tools = await mcpToolsFor([server], events, {});
      assert.equal(tools.length, 2);
      const read = tools.find((tool) => tool.name.endsWith("_getticket"))!;
      assert.match(read.description, /^\[API « Tickets »\]/);
      const outcome = await runTool(tools, { id: "r", name: read.name, arguments: { id: "VPN-12" } }, new AbortController().signal);
      assert.match(outcome.content, /^<mcp_result server="Tickets" tool="getTicket">\n\{"ok":true/);
      const write = tools.find((tool) => tool.name.endsWith("_createticket"))!;
      const denied = await runTool(tools, { id: "w", name: write.name, arguments: { body: { title: "VPN en panne" } } }, new AbortController().signal, async () => false);
      assert.equal(denied.denied, true);
      assert.equal(api.received.filter((request) => request.method === "POST").length, 0);
      await runTool(tools, { id: "w2", name: write.name, arguments: { body: { title: "VPN en panne" } } }, new AbortController().signal, async () => true);
      assert.deepEqual(JSON.parse(api.received.at(-1)!.body), { title: "VPN en panne" });
    } finally {
      await api.close();
    }
  });
});
