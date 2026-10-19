import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { OAuthServerConfig } from "./oauth.js";

/** Outil approuvé par l'administrateur, tel qu'il était au moment de l'approbation. */
export type ApprovedMcpTool = {
  name: string;
  title?: string | undefined;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Décidé par l'administrateur (l'indication du serveur n'est qu'un conseil). */
  access: "read" | "write";
  fingerprint: string;
};

export type McpServerStatus = "pending" | "approved" | "disabled";

/** token : un jeton pour toute l'organisation ; oauth : chaque utilisateur se connecte avec son compte. */
export type McpAuthMode = "token" | "oauth";

export type McpServerRecord = {
  id: string;
  name: string;
  url: string;
  /** mcp : serveur MCP ; openapi : API décrite par sa spécification. */
  kind: "mcp" | "openapi";
  auth: McpAuthMode;
  hasToken: boolean;
  status: McpServerStatus;
  tools: ApprovedMcpTool[];
  updatedAt: string;
};

export interface McpServerStore {
  list(tenant: TenantContext): Promise<McpServerRecord[]>;
  /** Avec le jeton : réservé aux appels du serveur, jamais renvoyé à l'interface. */
  connection(tenant: TenantContext, id: string): Promise<McpConnection | null>;
  create(tenant: TenantContext, input: McpServerInput): Promise<McpServerRecord>;
  approve(tenant: TenantContext, id: string, tools: ApprovedMcpTool[]): Promise<McpServerRecord | null>;
  setStatus(tenant: TenantContext, id: string, status: McpServerStatus): Promise<boolean>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
}

/** Serveur avec ses secrets (jeton d'organisation, configuration OAuth) : usage serveur seulement. */
export type McpConnection = McpServerRecord & { token: string | null; oauth: OAuthServerConfig | null; spec: unknown };

export type McpServerInput = { name: string; url: string; token?: string | undefined; oauth?: OAuthServerConfig | undefined; spec?: unknown };

export type Field = "url" | "token" | "tools" | "oauth" | "spec";
export const mcpServerAad = (tenant: TenantContext, id: string, field: Field) => `mcp-server-${field}:${tenant.organizationId}:${id}`;
const aad = mcpServerAad;

type Row = { id: string; name: string; url: string; kind: "mcp" | "openapi"; auth: McpAuthMode; token: string | null; oauth: string | null; spec: string | null; tools: string | null; status: McpServerStatus; updatedAt: string };
const COLUMNS = `id, name, url, kind, auth, token, oauth, spec, tools, status, updated_at AS "updatedAt"`;

export class PostgresMcpServerStore implements McpServerStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async record(client: PoolClient, tenant: TenantContext, row: Row, withToken = false) {
    const open = (value: string, field: Field) => this.keyring.decrypt(client, tenant.organizationId, value, aad(tenant, row.id, field));
    return {
      id: row.id,
      name: row.name,
      url: await open(row.url, "url"),
      kind: row.kind,
      auth: row.auth,
      hasToken: row.token !== null,
      status: row.status,
      tools: row.tools ? (JSON.parse(await open(row.tools, "tools")) as ApprovedMcpTool[]) : [],
      updatedAt: row.updatedAt,
      ...(withToken
        ? {
            token: row.token ? await open(row.token, "token") : null,
            oauth: row.oauth ? (JSON.parse(await open(row.oauth, "oauth")) as OAuthServerConfig) : null,
            spec: row.spec ? (JSON.parse(await open(row.spec, "spec")) as unknown) : null,
          }
        : {}),
    };
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (await client.query<Row>(`SELECT ${COLUMNS} FROM mcp_servers WHERE organization_id = $1 ORDER BY created_at`, [tenant.organizationId])).rows;
      const servers: McpServerRecord[] = [];
      for (const row of rows) servers.push(await this.record(client, tenant, row));
      return servers;
    });
  }

  connection(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<Row>(`SELECT ${COLUMNS} FROM mcp_servers WHERE id = $1 AND organization_id = $2`, [id, tenant.organizationId])).rows[0];
      return row ? ((await this.record(client, tenant, row, true)) as McpConnection) : null;
    });
  }

  create(tenant: TenantContext, input: McpServerInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const seal = (value: string, field: Field) => this.keyring.encrypt(client, tenant.organizationId, value, aad(tenant, id, field));
      const row = (
        await client.query<Row>(
          `INSERT INTO mcp_servers (id, organization_id, name, url, auth, token, oauth, created_by, kind, spec) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${COLUMNS}`,
          [
            id,
            tenant.organizationId,
            input.name,
            await seal(input.url, "url"),
            input.oauth ? "oauth" : "token",
            input.token ? await seal(input.token, "token") : null,
            input.oauth ? await seal(JSON.stringify(input.oauth), "oauth") : null,
            tenant.userId,
            input.spec !== undefined ? "openapi" : "mcp",
            input.spec !== undefined ? await seal(JSON.stringify(input.spec), "spec") : null,
          ],
        )
      ).rows[0]!;
      return this.record(client, tenant, row);
    });
  }

  approve(tenant: TenantContext, id: string, tools: ApprovedMcpTool[]) {
    return withTenant(this.pool, tenant, async (client) => {
      const sealed = await this.keyring.encrypt(client, tenant.organizationId, JSON.stringify(tools), aad(tenant, id, "tools"));
      const row = (
        await client.query<Row>(
          `UPDATE mcp_servers SET tools = $3, status = 'approved', updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, sealed],
        )
      ).rows[0];
      return row ? this.record(client, tenant, row) : null;
    });
  }

  setStatus(tenant: TenantContext, id: string, status: McpServerStatus) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("UPDATE mcp_servers SET status = $3, updated_at = now() WHERE id = $1 AND organization_id = $2", [id, tenant.organizationId, status]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM mcp_servers WHERE id = $1 AND organization_id = $2", [id, tenant.organizationId]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}

/** En mémoire : développement sans base, tests. */
export class MemoryMcpServerStore implements McpServerStore {
  private readonly servers = new Map<string, McpConnection & { organizationId: string }>();

  private mine(tenant: TenantContext) {
    return [...this.servers.values()].filter((server) => server.organizationId === tenant.organizationId);
  }

  private view({ organizationId: _org, token: _token, oauth: _oauth, spec: _spec, ...record }: McpConnection & { organizationId: string }): McpServerRecord {
    return structuredClone(record);
  }

  async list(tenant: TenantContext) {
    return this.mine(tenant).map((server) => this.view(server));
  }

  async connection(tenant: TenantContext, id: string) {
    const server = this.mine(tenant).find((item) => item.id === id);
    return server ? { ...this.view(server), token: server.token, oauth: server.oauth ? structuredClone(server.oauth) : null, spec: structuredClone(server.spec) } : null;
  }

  async create(tenant: TenantContext, input: McpServerInput) {
    const server = {
      id: randomUUID(),
      organizationId: tenant.organizationId,
      name: input.name,
      url: input.url,
      kind: (input.spec !== undefined ? "openapi" : "mcp") as "mcp" | "openapi",
      spec: input.spec ?? null,
      auth: (input.oauth ? "oauth" : "token") as McpAuthMode,
      hasToken: Boolean(input.token),
      token: input.token ?? null,
      oauth: input.oauth ?? null,
      status: "pending" as const,
      tools: [],
      updatedAt: new Date().toISOString(),
    };
    this.servers.set(server.id, server);
    return this.view(server);
  }

  async approve(tenant: TenantContext, id: string, tools: ApprovedMcpTool[]) {
    const server = this.mine(tenant).find((item) => item.id === id);
    if (!server) return null;
    Object.assign(server, { tools: structuredClone(tools), status: "approved", updatedAt: new Date().toISOString() });
    return this.view(server);
  }

  async setStatus(tenant: TenantContext, id: string, status: McpServerStatus) {
    const server = this.mine(tenant).find((item) => item.id === id);
    if (!server) return false;
    server.status = status;
    return true;
  }

  async delete(tenant: TenantContext, id: string) {
    return this.mine(tenant).some((item) => item.id === id) && this.servers.delete(id);
  }
}
