import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

export type Project = {
  id: string;
  name: string;
  conversationCount: number;
  createdAt: string;
  updatedAt: string;
};

export interface ProjectStore {
  list(tenant: TenantContext): Promise<Project[]>;
  create(tenant: TenantContext, name: string): Promise<Project>;
  rename(tenant: TenantContext, id: string, name: string): Promise<Project | null>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
}

export function projectNameAad(tenant: TenantContext, id: string) {
  return `project-name:${tenant.organizationId}:${tenant.userId}:${id}`;
}

type ProjectRow = { id: string; name: string; conversationCount: string; createdAt: string; updatedAt: string };

const SELECT = `SELECT p.id, p.name, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  (SELECT count(*) FROM conversations c
   WHERE c.project_id = p.id AND c.user_id = p.user_id AND c.organization_id = p.organization_id
  ) AS "conversationCount"
  FROM projects p`;

/** Projets personnels d'un membre, sous RLS ; nom chiffré par organisation. */
export class PostgresProjectStore implements ProjectStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async toProject(client: PoolClient, tenant: TenantContext, row: ProjectRow): Promise<Project> {
    return {
      id: row.id,
      name: await this.keyring.decrypt(client, tenant.organizationId, row.name, projectNameAad(tenant, row.id)),
      conversationCount: Number(row.conversationCount),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async one(client: PoolClient, tenant: TenantContext, id: string) {
    const result = await client.query<ProjectRow>(
      `${SELECT} WHERE p.id = $1 AND p.user_id = $2 AND p.organization_id = $3`,
      [id, tenant.userId, tenant.organizationId],
    );
    const row = result.rows[0];
    return row ? this.toProject(client, tenant, row) : null;
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<ProjectRow>(
        `${SELECT} WHERE p.user_id = $1 AND p.organization_id = $2
         ORDER BY p.updated_at DESC LIMIT 200`,
        [tenant.userId, tenant.organizationId],
      );
      const projects: Project[] = [];
      for (const row of result.rows) projects.push(await this.toProject(client, tenant, row));
      return projects;
    });
  }

  create(tenant: TenantContext, name: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const encrypted = await this.keyring.encrypt(client, tenant.organizationId, name, projectNameAad(tenant, id));
      const result = await client.query(
        `INSERT INTO projects (id, organization_id, user_id, name)
         SELECT $1, $2, $3, $4
         WHERE EXISTS (SELECT 1 FROM organization_members WHERE organization_id = $2 AND user_id = $3)`,
        [id, tenant.organizationId, tenant.userId, encrypted],
      );
      if (!result.rowCount) throw new Error("MEMBERSHIP_REQUIRED");
      return (await this.one(client, tenant, id))!;
    });
  }

  rename(tenant: TenantContext, id: string, name: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const encrypted = await this.keyring.encrypt(client, tenant.organizationId, name, projectNameAad(tenant, id));
      const result = await client.query(
        `UPDATE projects SET name = $4, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND organization_id = $3`,
        [id, tenant.userId, tenant.organizationId, encrypted],
      );
      return result.rowCount ? this.one(client, tenant, id) : null;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      // Les conversations restent : project_id passe à NULL (FK ON DELETE SET NULL).
      const result = await client.query(
        "DELETE FROM projects WHERE id = $1 AND user_id = $2 AND organization_id = $3",
        [id, tenant.userId, tenant.organizationId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}
