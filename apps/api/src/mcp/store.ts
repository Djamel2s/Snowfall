import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

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

export type McpServerRecord = {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  status: McpServerStatus;
  tools: ApprovedMcpTool[];
  updatedAt: string;
};

export interface McpServerStore {
  list(tenant: TenantContext): Promise<McpServerRecord[]>;
  /** Avec le jeton : réservé aux appels du serveur, jamais renvoyé à l'interface. */
  connection(tenant: TenantContext, id: string): Promise<(McpServerRecord & { token: string | null }) | null>;
  create(tenant: TenantContext, input: { name: string; url: string; token?: string | undefined }): Promise<McpServerRecord>;
  approve(tenant: TenantContext, id: string, tools: ApprovedMcpTool[]): Promise<McpServerRecord | null>;
  setStatus(tenant: TenantContext, id: string, status: McpServerStatus): Promise<boolean>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
}

const aad = (tenant: TenantContext, id: string, field: "url" | "token" | "tools") => `mcp-server-${field}:${tenant.organizationId}:${id}`;

type Row = { id: string; name: string; url: string; token: string | null; tools: string | null; status: McpServerStatus; updatedAt: string };
const COLUMNS = `id, name, url, token, tools, status, updated_at AS "updatedAt"`;

export class PostgresMcpServerStore implements McpServerStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async record(client: PoolClient, tenant: TenantContext, row: Row, withToken = false) {
    const open = (value: string, field: "url" | "token" | "tools") => this.keyring.decrypt(client, tenant.organizationId, value, aad(tenant, row.id, field));
    return {
      id: row.id,
      name: row.name,
      url: await open(row.url, "url"),
      hasToken: row.token !== null,
      status: row.status,
      tools: row.tools ? (JSON.parse(await open(row.tools, "tools")) as ApprovedMcpTool[]) : [],
      updatedAt: row.updatedAt,
      ...(withToken ? { token: row.token ? await open(row.token, "token") : null } : {}),
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
      return row ? ((await this.record(client, tenant, row, true)) as McpServerRecord & { token: string | null }) : null;
    });
  }

  create(tenant: TenantContext, input: { name: string; url: string; token?: string | undefined }) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const seal = (value: string, field: "url" | "token") => this.keyring.encrypt(client, tenant.organizationId, value, aad(tenant, id, field));
      const row = (
        await client.query<Row>(
          `INSERT INTO mcp_servers (id, organization_id, name, url, token, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, input.name, await seal(input.url, "url"), input.token ? await seal(input.token, "token") : null, tenant.userId],
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
  private readonly servers = new Map<string, McpServerRecord & { organizationId: string; token: string | null }>();

  private mine(tenant: TenantContext) {
    return [...this.servers.values()].filter((server) => server.organizationId === tenant.organizationId);
  }

  private view({ organizationId: _org, token: _token, ...record }: McpServerRecord & { organizationId: string; token: string | null }): McpServerRecord {
    return structuredClone(record);
  }

  async list(tenant: TenantContext) {
    return this.mine(tenant).map((server) => this.view(server));
  }

  async connection(tenant: TenantContext, id: string) {
    const server = this.mine(tenant).find((item) => item.id === id);
    return server ? { ...this.view(server), token: server.token } : null;
  }

  async create(tenant: TenantContext, input: { name: string; url: string; token?: string | undefined }) {
    const server = {
      id: randomUUID(),
      organizationId: tenant.organizationId,
      name: input.name,
      url: input.url,
      hasToken: Boolean(input.token),
      token: input.token ?? null,
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
