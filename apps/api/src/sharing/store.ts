import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Droits fins sur les agents et les prompts : à une personne, à un groupe ou à
// toute l'organisation, en lecture ou en modification. Le propriétaire (ou un
// administrateur, pour les agents) décide ; la RLS des ressources applique la
// lecture même si l'API se trompait (voir snowfall_access).

export type ResourceType = "agent" | "prompt" | "skill";
export type Permission = "view" | "edit";
export type Principal = { type: "user"; id: string } | { type: "group"; id: string } | { type: "organization" };
export type Grant = { principal: Principal; permission: Permission };
export type Group = { id: string; name: string; memberIds: string[] };
export type DirectoryEntry = { userId: string; email: string };

/** Autorisations par ressource, groupes par organisation : de quoi rester lisible. */
export const MAX_GRANTS = 50;
export const MAX_GROUPS = 100;

export class SharingRuleError extends Error {
  constructor(readonly code: "UNKNOWN_PRINCIPAL" | "FORBIDDEN" | "LIMIT") {
    super(code);
  }
}

export interface SharingStore {
  grants(tenant: TenantContext, type: ResourceType, id: string): Promise<Grant[]>;
  /** Remplace toutes les autorisations de la ressource. */
  setGrants(tenant: TenantContext, type: ResourceType, id: string, grants: Grant[]): Promise<Grant[]>;
  directory(tenant: TenantContext): Promise<DirectoryEntry[]>;
  groups(tenant: TenantContext): Promise<Group[]>;
  createGroup(tenant: TenantContext, name: string): Promise<Group>;
  updateGroup(tenant: TenantContext, id: string, changes: { name?: string; memberIds?: string[] }): Promise<Group | null>;
  deleteGroup(tenant: TenantContext, id: string): Promise<boolean>;
}

export const groupAad = (organizationId: string, id: string) => `member-group-name:${organizationId}:${id}`;

const principalKey = (principal: Principal) => (principal.type === "organization" ? "organization" : `${principal.type}:${principal.id}`);

/** Une autorisation par destinataire ; la plus large l'emporte. */
export function normalizeGrants(grants: Grant[]) {
  const byPrincipal = new Map<string, Grant>();
  for (const grant of grants) {
    const key = principalKey(grant.principal);
    const known = byPrincipal.get(key);
    if (!known || (known.permission === "view" && grant.permission === "edit")) byPrincipal.set(key, grant);
  }
  return [...byPrincipal.values()];
}

type GrantRow = { principalType: Principal["type"]; principalId: string | null; permission: Permission };
const toGrant = (row: GrantRow): Grant => ({
  principal: row.principalType === "organization" ? { type: "organization" } : { type: row.principalType, id: row.principalId! },
  permission: row.permission,
});

export class PostgresSharingStore implements SharingStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  /** Autorisations encore valables : destinataire toujours membre, groupe toujours là. */
  private async read(client: PoolClient, tenant: TenantContext, type: ResourceType, id: string) {
    const rows = await client.query<GrantRow>(
      `SELECT g.principal_type AS "principalType", g.principal_id AS "principalId", g.permission
       FROM resource_grants g
       WHERE g.organization_id = $1 AND g.resource_type = $2 AND g.resource_id = $3
         AND (g.principal_type = 'organization'
           OR (g.principal_type = 'user' AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = g.organization_id AND m.user_id = g.principal_id))
           OR (g.principal_type = 'group' AND EXISTS (SELECT 1 FROM member_groups mg WHERE mg.organization_id = g.organization_id AND mg.id = g.principal_id)))
       ORDER BY g.created_at, g.id`,
      [tenant.organizationId, type, id],
    );
    return rows.rows.map(toGrant);
  }

  grants(tenant: TenantContext, type: ResourceType, id: string) {
    return withTenant(this.pool, tenant, (client) => this.read(client, tenant, type, id));
  }

  setGrants(tenant: TenantContext, type: ResourceType, id: string, grants: Grant[]) {
    const wanted = normalizeGrants(grants);
    if (wanted.length > MAX_GRANTS) return Promise.reject(new SharingRuleError("LIMIT"));
    return withTenant(this.pool, tenant, async (client) => {
      const users = wanted.flatMap((grant) => (grant.principal.type === "user" ? [grant.principal.id] : []));
      const groups = wanted.flatMap((grant) => (grant.principal.type === "group" ? [grant.principal.id] : []));
      const knownUsers = await client.query("SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = ANY($2::uuid[])", [tenant.organizationId, users]);
      const knownGroups = await client.query("SELECT 1 FROM member_groups WHERE organization_id = $1 AND id = ANY($2::uuid[])", [tenant.organizationId, groups]);
      if (knownUsers.rowCount !== new Set(users).size || knownGroups.rowCount !== new Set(groups).size) throw new SharingRuleError("UNKNOWN_PRINCIPAL");

      // La RLS ne laisse retirer et poser que le propriétaire (ou un administrateur).
      await client.query("DELETE FROM resource_grants WHERE organization_id = $1 AND resource_type = $2 AND resource_id = $3", [tenant.organizationId, type, id]);
      try {
        for (const grant of wanted) {
          await client.query(
            `INSERT INTO resource_grants (organization_id, resource_type, resource_id, principal_type, principal_id, permission, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tenant.organizationId, type, id, grant.principal.type, grant.principal.type === "organization" ? null : grant.principal.id, grant.permission, tenant.userId],
          );
        }
      } catch (error) {
        if ((error as { code?: string }).code === "42501") throw new SharingRuleError("FORBIDDEN");
        throw error;
      }
      return this.read(client, tenant, type, id);
    });
  }

  directory(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = await client.query<DirectoryEntry>(
        `SELECT m.user_id AS "userId", u.email FROM organization_members m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = $1 ORDER BY u.email`,
        [tenant.organizationId],
      );
      return rows.rows;
    });
  }

  private async view(client: PoolClient, tenant: TenantContext, row: { id: string; name: string }): Promise<Group> {
    const members = await client.query<{ userId: string }>(
      `SELECT user_id AS "userId" FROM member_group_members WHERE organization_id = $1 AND group_id = $2 ORDER BY user_id`,
      [tenant.organizationId, row.id],
    );
    return {
      id: row.id,
      name: await this.keyring.decrypt(client, tenant.organizationId, row.name, groupAad(tenant.organizationId, row.id)),
      memberIds: members.rows.map((member) => member.userId),
    };
  }

  groups(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM member_groups WHERE organization_id = $1 ORDER BY created_at, id LIMIT ${MAX_GROUPS}`,
        [tenant.organizationId],
      );
      const groups: Group[] = [];
      for (const row of rows.rows) groups.push(await this.view(client, tenant, row));
      return groups;
    });
  }

  createGroup(tenant: TenantContext, name: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const count = await client.query<{ count: string }>("SELECT count(*) FROM member_groups WHERE organization_id = $1", [tenant.organizationId]);
      if (Number(count.rows[0]!.count) >= MAX_GROUPS) throw new SharingRuleError("LIMIT");
      const id = randomUUID();
      try {
        const row = (
          await client.query<{ id: string; name: string }>("INSERT INTO member_groups (id, organization_id, name) VALUES ($1, $2, $3) RETURNING id, name", [
            id,
            tenant.organizationId,
            await this.keyring.encrypt(client, tenant.organizationId, name, groupAad(tenant.organizationId, id)),
          ])
        ).rows[0]!;
        return this.view(client, tenant, row);
      } catch (error) {
        if ((error as { code?: string }).code === "42501") throw new SharingRuleError("FORBIDDEN");
        throw error;
      }
    });
  }

  updateGroup(tenant: TenantContext, id: string, changes: { name?: string; memberIds?: string[] }) {
    return withTenant(this.pool, tenant, async (client) => {
      const existing = await client.query<{ id: string; name: string }>("SELECT id, name FROM member_groups WHERE id = $1 AND organization_id = $2", [id, tenant.organizationId]);
      if (!existing.rowCount) return null;
      try {
        if (changes.name !== undefined) {
          const updated = await client.query("UPDATE member_groups SET name = $3 WHERE id = $1 AND organization_id = $2", [
            id,
            tenant.organizationId,
            await this.keyring.encrypt(client, tenant.organizationId, changes.name, groupAad(tenant.organizationId, id)),
          ]);
          if (!updated.rowCount) throw new SharingRuleError("FORBIDDEN");
        }
        if (changes.memberIds) {
          const members = [...new Set(changes.memberIds)];
          const known = await client.query("SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = ANY($2::uuid[])", [tenant.organizationId, members]);
          if (known.rowCount !== members.length) throw new SharingRuleError("UNKNOWN_PRINCIPAL");
          await client.query("DELETE FROM member_group_members WHERE organization_id = $1 AND group_id = $2", [tenant.organizationId, id]);
          for (const userId of members) {
            await client.query("INSERT INTO member_group_members (group_id, organization_id, user_id) VALUES ($1, $2, $3)", [id, tenant.organizationId, userId]);
          }
        }
      } catch (error) {
        if ((error as { code?: string }).code === "42501") throw new SharingRuleError("FORBIDDEN");
        throw error;
      }
      const row = (await client.query<{ id: string; name: string }>("SELECT id, name FROM member_groups WHERE id = $1 AND organization_id = $2", [id, tenant.organizationId])).rows[0]!;
      return this.view(client, tenant, row);
    });
  }

  deleteGroup(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      // Ses autorisations partent avec lui (un groupe recréé n'hérite de rien).
      await client.query("DELETE FROM resource_grants WHERE organization_id = $1 AND principal_type = 'group' AND principal_id = $2", [tenant.organizationId, id]);
      const deleted = await client.query("DELETE FROM member_groups WHERE id = $1 AND organization_id = $2", [id, tenant.organizationId]);
      return (deleted.rowCount ?? 0) > 0;
    });
  }
}

/** En mémoire : développement sans base, tests. */
export class MemorySharingStore implements SharingStore {
  private readonly grantsByResource = new Map<string, Grant[]>();
  private readonly groupList: (Group & { organizationId: string })[] = [];

  constructor(private readonly members: DirectoryEntry[] = []) {}

  async grants(tenant: TenantContext, type: ResourceType, id: string) {
    return structuredClone(this.grantsByResource.get(`${tenant.organizationId}:${type}:${id}`) ?? []);
  }

  async setGrants(tenant: TenantContext, type: ResourceType, id: string, grants: Grant[]) {
    const wanted = normalizeGrants(grants);
    if (wanted.length > MAX_GRANTS) throw new SharingRuleError("LIMIT");
    for (const grant of wanted) {
      if (grant.principal.type === "user" && !this.members.some((member) => member.userId === (grant.principal as { id: string }).id)) throw new SharingRuleError("UNKNOWN_PRINCIPAL");
      if (grant.principal.type === "group" && !this.groupList.some((group) => group.id === (grant.principal as { id: string }).id)) throw new SharingRuleError("UNKNOWN_PRINCIPAL");
    }
    this.grantsByResource.set(`${tenant.organizationId}:${type}:${id}`, structuredClone(wanted));
    return structuredClone(wanted);
  }

  /** Droit de l'utilisateur sur une ressource (comme snowfall_access) : pour les magasins en mémoire. */
  accessFor(tenant: TenantContext, type: ResourceType, id: string): Permission | null {
    const grants = (this.grantsByResource.get(`${tenant.organizationId}:${type}:${id}`) ?? []).filter((grant) => {
      if (grant.principal.type === "organization") return true;
      if (grant.principal.type === "user") return grant.principal.id === tenant.userId;
      const groupId = grant.principal.id;
      return this.groupList.some((group) => group.id === groupId && group.organizationId === tenant.organizationId && group.memberIds.includes(tenant.userId));
    });
    return grants.some((grant) => grant.permission === "edit") ? "edit" : grants.length ? "view" : null;
  }

  async directory() {
    return structuredClone(this.members);
  }

  async groups(tenant: TenantContext) {
    return this.groupList.filter((group) => group.organizationId === tenant.organizationId).map(({ organizationId: _org, ...group }) => structuredClone(group));
  }

  async createGroup(tenant: TenantContext, name: string) {
    const group = { id: randomUUID(), name, memberIds: [], organizationId: tenant.organizationId };
    this.groupList.push(group);
    return { id: group.id, name, memberIds: [] };
  }

  async updateGroup(tenant: TenantContext, id: string, changes: { name?: string; memberIds?: string[] }) {
    const group = this.groupList.find((item) => item.id === id && item.organizationId === tenant.organizationId);
    if (!group) return null;
    if (changes.memberIds?.some((userId) => !this.members.some((member) => member.userId === userId))) throw new SharingRuleError("UNKNOWN_PRINCIPAL");
    if (changes.name !== undefined) group.name = changes.name;
    if (changes.memberIds) group.memberIds = [...new Set(changes.memberIds)];
    return { id: group.id, name: group.name, memberIds: [...group.memberIds] };
  }

  async deleteGroup(tenant: TenantContext, id: string) {
    const index = this.groupList.findIndex((item) => item.id === id && item.organizationId === tenant.organizationId);
    if (index === -1) return false;
    this.groupList.splice(index, 1);
    return true;
  }
}
