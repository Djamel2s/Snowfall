import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { ModelSelection, ProviderId } from "../llm/types.js";
import { defaultAgentTools, knownTools } from "../agent/catalog.js";
import { readAvatar, type AgentProfile } from "./profile.js";

export type Agent = AgentProfile & ModelSelection & {
  id: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Autorisation de l'utilisateur courant (partage) ; absente : aucune (auteur, administrateur, ou ancien magasin). */
  access?: "view" | "edit";
  /** Compétences confiées à l'agent (identifiants). */
  skills: string[];
};

/** tools absent : lecture seule (defaultAgentTools) ; mcpServers absent : aucun. */
export type AgentInput = Omit<AgentProfile, "tools" | "mcpServers" | "parameters" | "delegates"> & Partial<Pick<AgentProfile, "tools" | "mcpServers" | "parameters" | "delegates">> & ModelSelection & {
  /** Compétences confiées (absent : inchangées). */
  skills?: string[];
};

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
  access: "view" | "edit" | null;
  skills: string[];
};

// access : droit accordé à l'utilisateur courant (la RLS filtre déjà les invisibles).
const COLUMNS = `id, provider, model, profile_enc, created_by,
  created_at AS "createdAt", updated_at AS "updatedAt", snowfall_access('agent', id) AS access,
  ARRAY(SELECT x.skill_id::text FROM agent_skills x WHERE x.agent_id = agents.id ORDER BY x.skill_id) AS skills`;

export function profileAad(organizationId: string, agentId: string) {
  return `agent-profile:${organizationId}:${agentId}`;
}

/** Agents de l'organisation, visibles selon leurs autorisations (RLS) ; profil chiffré par organisation. */
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
      // Profil enregistré avant le choix des outils, ou outil retiré du catalogue.
      tools: knownTools(profile.tools ?? defaultAgentTools),
      mcpServers: profile.mcpServers ?? [],
      delegates: profile.delegates ?? [],
      parameters: profile.parameters ?? {},
      id: row.id,
      provider: row.provider,
      model: row.model,
      createdBy: row.created_by,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.access ? { access: row.access } : {}),
      skills: row.skills ?? [],
    };
  }

  private seal(client: PoolClient, tenant: TenantContext, id: string, input: AgentInput) {
    const profile: AgentProfile = {
      name: input.name,
      avatar: input.avatar,
      instructions: input.instructions,
      tools: knownTools(input.tools ?? defaultAgentTools),
      mcpServers: [...new Set(input.mcpServers ?? [])],
      delegates: [...new Set(input.delegates ?? [])],
      parameters: input.parameters ?? {},
    };
    return this.keyring.encrypt(
      client,
      tenant.organizationId,
      JSON.stringify(profile),
      profileAad(tenant.organizationId, id),
    );
  }

  /** Compétences confiées : n'ajoute que les nouvelles, retire les enlevées (la RLS vérifie qu'on voit la compétence ajoutée). */
  private async setSkills(client: PoolClient, tenant: TenantContext, agentId: string, skills: string[] | undefined) {
    if (!skills) return;
    const current = (await client.query<{ skillId: string }>(`SELECT skill_id::text AS "skillId" FROM agent_skills WHERE agent_id = $1`, [agentId])).rows.map((row) => row.skillId);
    const wanted = [...new Set(skills)];
    const removed = current.filter((id) => !wanted.includes(id));
    if (removed.length) await client.query("DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = ANY($2::uuid[])", [agentId, removed]);
    for (const skillId of wanted.filter((id) => !current.includes(id))) {
      await client.query("INSERT INTO agent_skills (agent_id, skill_id, organization_id) VALUES ($1, $2, $3)", [agentId, skillId, tenant.organizationId]);
    }
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
      if (input.skills?.length) {
        await this.setSkills(client, tenant, id, input.skills);
        return this.toAgent(client, tenant, (await client.query<AgentRow>(`SELECT ${COLUMNS} FROM agents WHERE id = $1`, [id])).rows[0]!);
      }
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
      if (!row) return null;
      if (!input.skills) return this.toAgent(client, tenant, row);
      await this.setSkills(client, tenant, id, input.skills);
      return this.toAgent(client, tenant, (await client.query<AgentRow>(`SELECT ${COLUMNS} FROM agents WHERE id = $1`, [id])).rows[0]!);
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      // Ses autorisations partent avec lui (pas de clé étrangère : ressource polymorphe).
      await client.query("DELETE FROM resource_grants WHERE organization_id = $1 AND resource_type = 'agent' AND resource_id = $2", [tenant.organizationId, id]);
      const result = await client.query(
        "DELETE FROM agents WHERE id = $1 AND organization_id = $2",
        [id, tenant.organizationId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
