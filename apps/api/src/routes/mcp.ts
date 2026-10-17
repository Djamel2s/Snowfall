import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { McpClient, McpError, validateMcpUrl } from "../mcp/client.js";
import type { McpServerRecord, McpServerStore } from "../mcp/store.js";
import { approvedSnapshot, exposedName, schemaValidator } from "../mcp/tools.js";
import type { RouteKit } from "./kit.js";

// Serveurs MCP de l'organisation. Seul un administrateur ajoute un serveur,
// examine ses outils et choisit lesquels approuver (et s'ils lisent ou
// écrivent). La liste approuvée est figée avec une empreinte par outil.

export type McpDependencies = {
  store: McpServerStore;
  /** Tests seulement : faux serveur MCP local en HTTP. */
  allowLocal?: boolean;
  fetcher?: typeof fetch;
};

const idParams = z.object({ id: z.uuid() });

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: z.string().trim().max(2_000),
  token: z.string().trim().min(1).max(4_000).optional(),
}).strict();

const approveSchema = z.object({
  tools: z.array(z.object({ name: z.string().min(1).max(128), access: z.enum(["read", "write"]) }).strict()).min(1).max(100),
}).strict();

const statusSchema = z.object({ enabled: z.boolean() }).strict();

/** Vue d'un serveur : jamais le jeton ; l'adresse pour les seuls administrateurs. */
function view(server: McpServerRecord, admin: boolean) {
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    ...(admin ? { url: server.url, hasToken: server.hasToken, updatedAt: server.updatedAt } : {}),
    tools: server.tools.map((tool) => ({ name: tool.name, title: tool.title ?? null, access: tool.access })),
  };
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

export function registerMcpRoutes(api: FastifyInstance, kit: RouteKit, deps: McpDependencies) {
  const { store } = deps;

  const connect = async (user: Parameters<McpServerStore["connection"]>[0], id: string) => {
    const server = await store.connection(user, id);
    if (!server) return null;
    return { server, client: new McpClient({ url: server.url, token: server.token ?? undefined }, deps.fetcher) };
  };

  // Tous les membres : les auteurs d'agents choisissent parmi les serveurs approuvés.
  api.get("/organization/mcp-servers", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const admin = kit.isAdmin(user);
    const servers = await store.list(user);
    return { servers: servers.filter((server) => admin || server.status === "approved").map((server) => view(server, admin)) };
  });

  api.post("/organization/mcp-servers", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    let url: URL;
    try {
      url = validateMcpUrl(body.data.url, deps.allowLocal);
    } catch {
      return reply.code(400).send({ error: "Invalid request", reason: "invalid_url" });
    }
    const server = await store.create(user, { name: body.data.name, url: url.href, token: body.data.token });
    await kit.record(request, user, {
      eventType: "mcp.server_create",
      targetType: "mcp_server",
      targetId: server.id,
      details: { host: url.host },
    });
    return reply.code(201).send({ server: view(server, true) });
  });

  // Outils publiés par le serveur, à examiner avant approbation.
  api.post("/organization/mcp-servers/:id/discover", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const connection = await connect(user, params.data.id);
    if (!connection) return reply.code(404).send({ error: "Not found" });
    try {
      const tools = await connection.client.listTools();
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description,
          // Indication du serveur, non fiable : l'administrateur décide.
          readOnlyHint: tool.readOnlyHint,
          // Schéma trop gros ou illisible, ou nom inutilisable : non proposable.
          supported: schemaValidator(tool.inputSchema) !== null && /^[a-z][a-z0-9_]{0,63}$/.test(exposedName(connection.server.name, tool.name)),
          approved: connection.server.tools.some((approved) => approved.name === tool.name),
        })),
      };
    } catch (error) {
      return reply.code(502).send({ error: "MCP server unavailable", reason: error instanceof McpError ? error.code : "network" });
    }
  });

  // Approbation : les outils sont relus sur le serveur et figés tels quels.
  api.post("/organization/mcp-servers/:id/approve", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

    const params = idParams.safeParse(request.params);
    const body = approveSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const connection = await connect(user, params.data.id);
    if (!connection) return reply.code(404).send({ error: "Not found" });

    let live;
    try {
      live = await connection.client.listTools();
    } catch (error) {
      return reply.code(502).send({ error: "MCP server unavailable", reason: error instanceof McpError ? error.code : "network" });
    }
    const snapshots = [];
    for (const choice of body.data.tools) {
      const definition = live.find((tool) => tool.name === choice.name);
      if (!definition || !schemaValidator(definition.inputSchema)) return reply.code(400).send({ error: "Invalid request", reason: "unknown_tool" });
      snapshots.push(approvedSnapshot(definition, choice.access));
    }
    const server = await store.approve(user, params.data.id, snapshots);
    if (!server) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, {
      eventType: "mcp.server_approve",
      targetType: "mcp_server",
      targetId: server.id,
      details: {
        tools: snapshots.map((tool) => tool.name).join(",").slice(0, 500),
        writes: snapshots.filter((tool) => tool.access === "write").length,
      },
    });
    return { server: view(server, true) };
  });

  // Suspendre / réactiver sans perdre l'approbation.
  api.patch("/organization/mcp-servers/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

    const params = idParams.safeParse(request.params);
    const body = statusSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const server = await store.connection(user, params.data.id);
    if (!server) return reply.code(404).send({ error: "Not found" });
    const status = !body.data.enabled ? "disabled" : server.tools.length ? "approved" : "pending";
    await store.setStatus(user, server.id, status);
    await kit.record(request, user, {
      eventType: "mcp.server_status",
      targetType: "mcp_server",
      targetId: server.id,
      details: { status },
    });
    return { server: view({ ...server, status }, true) };
  });

  api.delete("/organization/mcp-servers/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    const server = await store.connection(user, params.data.id);
    if (!server || !(await store.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, {
      eventType: "mcp.server_delete",
      targetType: "mcp_server",
      targetId: params.data.id,
      details: { host: host(server.url) },
    });
    return reply.code(204).send();
  });
}
