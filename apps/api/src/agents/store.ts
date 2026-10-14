import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { ModelSelection, ProviderId } from "../llm/types.js";
import { readAvatar, type AgentProfile } from "./profile.js";

export type Agent = AgentProfile & ModelSelection & {
  id: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentInput = AgentProfile & ModelSelection;

export interface AgentStore {
  list(tenant: TenantContext): Promise<Agent[]>;
  get(tenant: TenantContext, id: string): Promise<Agent | null>;
  create(tenant: TenantContext, input: AgentInput): Promise<Agent>;
  update(tenant: TenantContext, id: string, input: AgentInput): Promise<Agent | null>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
}

type AgentRow = {
  id: string;
  provider: ProviderId;
  model: string;
  profile_enc: string;
  created_by: string | null;
  createdAt: string;
  updatedAt: string;
};

const COLUMNS = `id, provider, model, profile_enc, created_by,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function profileAad(organizationId: string, agentId: string) {
  return `agent-profile:${organizationId}:${agentId}`;
}

/** Agents partagés par l'organisation, sous RLS ; profil chiffré par organisation. */
export class PostgresAgentStore implements AgentStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async toAgent(client: PoolClient, tenant: TenantContext, row: AgentRow): Promise<Agent> {
    const profile = JSON.parse(
      await this.keyring.decrypt(
        client,
        tenant.organizationId,
        row.profile_enc,
        profileAad(tenant.organizationId, row.id),
      ),
    ) as AgentProfile;

    return {
      ...profile,
      avatar: readAvatar(profile.avatar),
      id: row.id,
      provider: row.provider,
      model: row.model,
      createdBy: row.created_by,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private seal(client: PoolClient, tenant: TenantContext, id: string, input: AgentInput) {
    const profile: AgentProfile = {
      name: input.name,
      avatar: input.avatar,
      instructions: input.instructions,
    };
    return this.keyring.encrypt(
      client,
      tenant.organizationId,
      JSON.stringify(profile),
      profileAad(tenant.organizationId, id),
    );
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<AgentRow>(
        `SELECT ${COLUMNS} FROM agents
         WHERE organization_id = $1
         ORDER BY created_at ASC
         LIMIT 200`,
        [tenant.organizationId],
      );
      const agents: Agent[] = [];
      for (const row of result.rows) agents.push(await this.toAgent(client, tenant, row));
      return agents;
    });
  }

  get(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<AgentRow>(
        `SELECT ${COLUMNS} FROM agents WHERE id = $1 AND organization_id = $2`,
        [id, tenant.organizationId],
      );
      const row = result.rows[0];
      return row ? this.toAgent(client, tenant, row) : null;
    });
  }

  create(tenant: TenantContext, input: AgentInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const result = await client.query<AgentRow>(
        `INSERT INTO agents (id, organization_id, created_by, provider, model, profile_enc)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${COLUMNS}`,
        [
          id,
          tenant.organizationId,
          tenant.userId,
          input.provider,
          input.model,
          await this.seal(client, tenant, id, input),
        ],
      );
      return this.toAgent(client, tenant, result.rows[0]!);
    });
  }

  update(tenant: TenantContext, id: string, input: AgentInput) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<AgentRow>(
        `UPDATE agents
         SET provider = $3, model = $4, profile_enc = $5, updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING ${COLUMNS}`,
        [id, tenant.organizationId, input.provider, input.model, await this.seal(client, tenant, id, input)],
      );
      const row = result.rows[0];
      return row ? this.toAgent(client, tenant, row) : null;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        "DELETE FROM agents WHERE id = $1 AND organization_id = $2",
        [id, tenant.organizationId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
