import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { McpError, toolFingerprint, validateMcpUrl, type McpServerSettings } from "../mcp/client.js";
import type { McpConnectionStore } from "../mcp/connections.js";
import { authorizationUrl, discoverOAuth, exchangeCode, hashState, newState, OAuthError, pkce } from "../mcp/oauth.js";
import type { McpServerRecord, McpServerStore } from "../mcp/store.js";
import { bearerFor } from "../mcp/user-token.js";
import { approvedSnapshot, clashingNames, connectorClient, exposedName, schemaValidator, validToolName } from "../mcp/tools.js";
import { OpenApiError, parseOpenApi } from "../mcp/openapi.js";
import { catalogIdFor, CONNECTOR_CATALOG, connectorUrl } from "../mcp/catalog.js";
import type { RouteKit } from "./kit.js";

// Serveurs MCP de l'organisation. Seul un administrateur ajoute un serveur,
// examine ses outils et choisit lesquels approuver (et s'ils lisent ou
// écrivent). La liste approuvée est figée avec une empreinte par outil.

export type McpDependencies = {
  store: McpServerStore;
  /** Connexions personnelles (serveurs en mode OAuth). Absent : mode OAuth indisponible. */
  connections?: McpConnectionStore;
  /** Adresse de retour OAuth (page de l'application) ; fixée par le serveur, jamais par la requête. */
  redirectUri?: string;
  /** Tests seulement : faux serveur MCP local en HTTP. */
  allowLocal?: boolean;
  fetcher?: typeof fetch;
  /** Contrôle des adresses résolues, quand aucun proxy de sortie n'est configuré. */
  checkAddress?: McpServerSettings["checkAddress"];
};

const idParams = z.object({ id: z.uuid() });

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    url: z.string().trim().max(2_000),
    token: z.string().trim().min(1).max(4_000).optional(),
    // Mode OAuth : chaque utilisateur se connecte avec son compte. Client enregistré par l'admin chez le fournisseur.
    oauth: z
      .object({
        // Absent : enregistrement dynamique chez le fournisseur (RFC 7591), s'il le permet.
        clientId: z.string().trim().min(1).max(500).optional(),
        clientSecret: z.string().trim().min(1).max(4_000).optional(),
        scope: z.string().trim().max(500).regex(/^[\x21\x23-\x5b\x5d-\x7e ]*$/).optional(),
      })
      .strict()
      .optional(),
    // Connecteur OpenAPI : spécification (JSON) de l'API ; url = adresse de base de l'API.
    openapi: z.object({ spec: z.record(z.string(), z.unknown()) }).strict().optional(),
  })
  .strict()
  .refine((body) => !(body.oauth && body.token) && !(body.openapi && body.oauth));

const catalogAddSchema = z
  .object({
    tenant: z.string().trim().max(64).optional(),
    clientId: z.string().trim().min(1).max(500).optional(),
    clientSecret: z.string().trim().min(1).max(4_000).optional(),
    token: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

const callbackSchema = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(2_000) }).strict();

const approveSchema = z.object({
  // Empreinte de la définition EXAMINÉE (renvoyée par /discover) : on approuve ce
  // que l'admin a lu, pas ce que le serveur renverrait au moment du clic.
  tools: z
    .array(z.object({ name: z.string().min(1).max(128), access: z.enum(["read", "write"]), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
    .min(1)
    .max(100),
}).strict();

const statusSchema = z.object({ enabled: z.boolean() }).strict();

/** Vue d'un serveur : jamais le jeton ; l'adresse pour les seuls administrateurs. */
function view(server: McpServerRecord, admin: boolean) {
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    kind: server.kind,
    auth: server.auth,
    // Connecteur du catalogue (logo, catégorie) reconnu à son adresse.
    ...(catalogIdFor(server.url) ? { catalogId: catalogIdFor(server.url) } : {}),
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

  const tokenDeps = { connections: deps.connections, fetcher: deps.fetcher, checkAddress: deps.checkAddress, allowLocal: deps.allowLocal };

  /**
   * Client vers le serveur, avec le jeton de l'organisation (mode token) ou
   * celui de l'utilisateur courant (mode OAuth : l'admin examine avec SON compte).
   * needsConnection : mode OAuth, utilisateur pas (ou plus) connecté.
   */
  const connect = async (user: Parameters<McpServerStore["connection"]>[0], id: string) => {
    const server = await store.connection(user, id);
    if (!server) return null;
    const token = await bearerFor(server, user, tokenDeps);
    if (token === null) return { server, client: null };
    return { server, client: connectorClient(server, { url: server.url, token: token ?? undefined, checkAddress: deps.checkAddress }, deps.fetcher) };
  };
  const connectionRequired = (reply: FastifyReply) => reply.code(409).send({ error: "Conflict", reason: "connect_required" });

  // Tous les membres : les auteurs d'agents choisissent parmi les serveurs approuvés.
  api.get("/organization/mcp-servers", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const admin = kit.isAdmin(user);
    const servers = await store.list(user);
    return { servers: servers.filter((server) => admin || server.status === "approved").map((server) => view(server, admin)) };
  });

  /** Ajout d'un serveur (saisi à la main ou venu du catalogue) : mêmes contrôles pour les deux. */
  async function addServer(request: FastifyRequest, reply: FastifyReply, user: ReturnType<RouteKit["principal"]>, input: z.infer<typeof createSchema>, catalogId?: string) {
    let url: URL;
    try {
      url = validateMcpUrl(input.url, deps.allowLocal);
    } catch {
      return reply.code(400).send({ error: "Invalid request", reason: "invalid_url" });
    }
    if ((await store.list(user)).some((server) => server.url === url.href)) return reply.code(409).send({ error: "Conflict", reason: "already_added" });
    let oauth;
    if (input.oauth) {
      if (!deps.connections || !deps.redirectUri) return reply.code(400).send({ error: "Invalid request", reason: "oauth_unavailable" });
      try {
        // Points d'accès découverts chez le serveur MCP lui-même, puis vérifiés (HTTPS, adresse publique) ;
        // client enregistré automatiquement si le fournisseur le permet.
        oauth = await discoverOAuth(url.href, input.oauth, { fetcher: deps.fetcher, checkAddress: deps.checkAddress, allowLocal: deps.allowLocal, redirectUri: deps.redirectUri });
      } catch (error) {
        return reply.code(400).send({ error: "Invalid request", reason: error instanceof OAuthError ? `oauth_${error.code}` : "oauth_discovery_failed" });
      }
    }
    if (input.openapi) {
      try {
        // Lue dès l'ajout : une spécification illisible est refusée tout de suite.
        parseOpenApi(input.openapi.spec);
      } catch (error) {
        return reply.code(400).send({ error: "Invalid request", reason: error instanceof OpenApiError ? error.code : "invalid_spec" });
      }
    }
    const server = await store.create(user, { name: input.name, url: url.href, token: input.token, oauth, ...(input.openapi ? { spec: input.openapi.spec } : {}) });
    await kit.record(request, user, {
      eventType: "mcp.server_create",
      targetType: "mcp_server",
      targetId: server.id,
      details: { host: url.host, auth: server.auth, kind: server.kind, ...(catalogId ? { catalog: catalogId } : {}) },
    });
    return reply.code(201).send({ server: view(server, true) });
  }

  api.post("/organization/mcp-servers", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    return addServer(request, reply, user, body.data);
  });

  // Catalogue de connecteurs connus : lisible par tous (ce qui existe), ajouté par un administrateur.
  api.get("/mcp-catalog", async (_request, reply) => {
    reply.header("Cache-Control", "private, max-age=3600");
    return { connectors: CONNECTOR_CATALOG };
  });

  api.post("/organization/mcp-catalog/:id", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const params = z.object({ id: z.string().regex(/^[a-z0-9-]{1,60}$/) }).safeParse(request.params);
    const body = catalogAddSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const connector = CONNECTOR_CATALOG.find((item) => item.id === params.data.id);
    if (!connector) return reply.code(404).send({ error: "Not found" });
    // L'adresse vient du catalogue, jamais de la requête (seul le tenant s'y insère, contrôlé).
    const url = connectorUrl(connector, body.data.tenant);
    if (!url) return reply.code(400).send({ error: "Invalid request", reason: "tenant_required" });
    if (connector.auth === "token" && !body.data.token) return reply.code(400).send({ error: "Invalid request", reason: "token_required" });
    return addServer(
      request,
      reply,
      user,
      {
        name: connector.name,
        url,
        ...(connector.auth === "token" ? { token: body.data.token } : {}),
        ...(connector.auth === "oauth"
          ? {
              oauth: {
                ...(body.data.clientId ? { clientId: body.data.clientId } : {}),
                ...(body.data.clientSecret ? { clientSecret: body.data.clientSecret } : {}),
                ...(connector.scope ? { scope: connector.scope } : {}),
              },
            }
          : {}),
      },
      connector.id,
    );
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
    if (!connection.client) return connectionRequired(reply);
    try {
      const tools = await connection.client.listTools();
      const clashes = clashingNames(connection.server, tools.map((tool) => tool.name));
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? null,
          description: tool.description,
          // Indication du serveur, non fiable : l'administrateur décide.
          readOnlyHint: tool.readOnlyHint,
          // Schéma trop gros ou illisible, ou nom inutilisable : non proposable.
          // Le schéma est lu par le modèle (descriptions des paramètres comprises) : l'admin le voit aussi.
          inputSchema: tool.inputSchema,
          supported: schemaValidator(tool.inputSchema) !== null && validToolName(exposedName(connection.server, tool.name)) && !clashes.has(tool.name),
          fingerprint: toolFingerprint(tool),
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
    if (!connection.client) return connectionRequired(reply);

    let live;
    try {
      live = await connection.client.listTools();
    } catch (error) {
      return reply.code(502).send({ error: "MCP server unavailable", reason: error instanceof McpError ? error.code : "network" });
    }
    // Mêmes règles qu'à l'examen : nom exposable, aucun conflit de nom entre outils approuvés.
    const names = body.data.tools.map((choice) => choice.name);
    if (new Set(names).size !== names.length || clashingNames(connection.server, names).size || names.some((name) => !validToolName(exposedName(connection.server, name)))) {
      return reply.code(400).send({ error: "Invalid request", reason: "tool_name" });
    }
    const snapshots = [];
    for (const choice of body.data.tools) {
      const definition = live.find((tool) => tool.name === choice.name);
      if (!definition || !schemaValidator(definition.inputSchema)) return reply.code(400).send({ error: "Invalid request", reason: "unknown_tool" });
      // Le serveur a changé l'outil depuis l'examen : rien n'est approuvé, l'admin doit relire.
      if (toolFingerprint(definition) !== choice.fingerprint) {
        await kit.record(request, user, {
          eventType: "mcp.tool_changed",
          outcome: "denied",
          targetType: "mcp_server",
          targetId: connection.server.id,
          details: { tool: definition.name, stage: "approval" },
        });
        return reply.code(409).send({ error: "Conflict", reason: "tool_changed" });
      }
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

  // ---- Connexions personnelles (serveurs en mode OAuth) ------------------------

  /** Serveurs OAuth proposés à l'utilisateur, et s'il y est connecté. */
  api.get("/me/mcp-connections", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!deps.connections) return { connections: [] };
    const admin = kit.isAdmin(user);
    const connected = new Set(await deps.connections.connected(user));
    const servers = (await store.list(user)).filter((server) => server.auth === "oauth" && (server.status === "approved" || (admin && server.status === "pending")));
    return { connections: servers.map((server) => ({ id: server.id, name: server.name, status: server.status, connected: connected.has(server.id) })) };
  });

  /** Début de connexion : adresse du fournisseur, avec state et PKCE gardés côté serveur. */
  api.post("/mcp-servers/:id/connect", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!deps.connections || !deps.redirectUri) return reply.code(404).send({ error: "Not found" });
    const server = await store.connection(user, params.data.id);
    const allowed = server && server.auth === "oauth" && server.oauth && (server.status === "approved" || (kit.isAdmin(user) && server.status === "pending"));
    if (!allowed) return reply.code(404).send({ error: "Not found" });
    const state = newState();
    const { verifier, challenge } = pkce();
    await deps.connections.savePending(user, hashState(state), { serverId: server.id, verifier });
    return { authorizationUrl: authorizationUrl(server.oauth!, { state, challenge, redirectUri: deps.redirectUri, resource: server.url }) };
  });

  /**
   * Retour du fournisseur : la page /mcp/callback de l'application transmet code
   * et state en POST (même site : cookie de session et contrôle d'origine
   * habituels). Le state est à usage unique et lié à l'utilisateur qui a commencé.
   */
  api.post("/mcp/oauth/callback", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!deps.connections || !deps.redirectUri) return reply.code(404).send({ error: "Not found" });
    const body = callbackSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const pending = await deps.connections.takePending(user, hashState(body.data.state));
    if (!pending) {
      await kit.record(request, user, { eventType: "mcp.connect", outcome: "denied", targetType: "user", targetId: user.userId, details: { reason: "invalid_state" } });
      return reply.code(400).send({ error: "Invalid request", reason: "invalid_state" });
    }
    const server = await store.connection(user, pending.serverId);
    if (!server || server.auth !== "oauth" || !server.oauth) return reply.code(404).send({ error: "Not found" });
    try {
      const tokens = await exchangeCode(server.oauth, { code: body.data.code, verifier: pending.verifier, redirectUri: deps.redirectUri, resource: server.url }, { fetcher: deps.fetcher, checkAddress: deps.checkAddress, allowLocal: deps.allowLocal });
      await deps.connections.saveTokens(user, server.id, tokens);
    } catch (error) {
      await kit.record(request, user, { eventType: "mcp.connect", outcome: "failure", targetType: "mcp_server", targetId: server.id, details: { reason: error instanceof OAuthError ? error.code : "token_failed" } });
      return reply.code(502).send({ error: "Connection failed", reason: "token_failed" });
    }
    await kit.record(request, user, { eventType: "mcp.connect", targetType: "mcp_server", targetId: server.id });
    return { serverId: server.id, name: server.name };
  });

  api.delete("/mcp-servers/:id/connection", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!deps.connections || !(await deps.connections.deleteTokens(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    await kit.record(request, user, { eventType: "mcp.disconnect", targetType: "mcp_server", targetId: params.data.id });
    return reply.code(204).send();
  });
}
