import type { Pool } from "pg";
import type { OrganizationRole } from "../auth/auth.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

export type Member = { userId: string; email: string; role: OrganizationRole; joinedAt: string };

export type Invitation = {
  id: string;
  email: string;
  role: "admin" | "member" | "reader";
  createdAt: string;
  expiresAt: string;
};

export type OrganizationProfile = {
  id: string;
  name: string;
  sso: { alias: string | null; defaultRole: "member" | "reader" };
};

/** Erreurs métier renvoyées par les fonctions SQL de gestion des membres. */
export class MemberRuleError extends Error {
  constructor(readonly code: "FORBIDDEN" | "SELF_CHANGE_FORBIDDEN" | "MEMBER_NOT_FOUND" | "CONFLICT") {
    super(code);
  }
}

export const INVITATION_DAYS = 14;

export interface MemberStore {
  organization(tenant: TenantContext): Promise<OrganizationProfile>;
  list(tenant: TenantContext): Promise<Member[]>;
  setRole(tenant: TenantContext, userId: string, role: OrganizationRole): Promise<void>;
  remove(tenant: TenantContext, userId: string): Promise<void>;
  invitations(tenant: TenantContext): Promise<Invitation[]>;
  invite(tenant: TenantContext, email: string, role: Invitation["role"]): Promise<Invitation>;
  revokeInvitation(tenant: TenantContext, id: string): Promise<boolean>;
  setSso(tenant: TenantContext, alias: string | null, defaultRole: "member" | "reader"): Promise<void>;
}

function translate(error: unknown): never {
  const pg = error as { code?: string; message?: string };
  if (pg.code === "42501") {
    throw new MemberRuleError(pg.message === "SELF_CHANGE_FORBIDDEN" ? "SELF_CHANGE_FORBIDDEN" : "FORBIDDEN");
  }
  if (pg.code === "P0002") throw new MemberRuleError("MEMBER_NOT_FOUND");
  if (pg.code === "23505") throw new MemberRuleError("CONFLICT");
  throw error;
}

export class PostgresMemberStore implements MemberStore {
  constructor(private readonly pool: Pool) {}

  organization(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{
        id: string;
        name: string;
        sso_alias: string | null;
        sso_default_role: "member" | "reader";
      }>(
        "SELECT id, name, sso_alias, sso_default_role FROM organizations WHERE id = $1",
        [tenant.organizationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("ORGANIZATION_NOT_FOUND");
      return { id: row.id, name: row.name, sso: { alias: row.sso_alias, defaultRole: row.sso_default_role } };
    });
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<Member>(
        `SELECT m.user_id AS "userId", u.email, m.role, m.created_at AS "joinedAt"
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = $1
         ORDER BY m.created_at ASC`,
        [tenant.organizationId],
      );
      return result.rows;
    });
  }

  async setRole(tenant: TenantContext, userId: string, role: OrganizationRole) {
    await withTenant(this.pool, tenant, (client) =>
      client.query("SELECT snowfall_set_member_role($1, $2)", [userId, role]),
    ).catch(translate);
  }

  async remove(tenant: TenantContext, userId: string) {
    await withTenant(this.pool, tenant, (client) =>
      client.query("SELECT snowfall_remove_member($1)", [userId]),
    ).catch(translate);
  }

  invitations(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<Invitation>(
        `SELECT id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"
         FROM organization_invitations
         WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC`,
        [tenant.organizationId],
      );
      return result.rows;
    });
  }

  invite(tenant: TenantContext, email: string, role: Invitation["role"]) {
    return withTenant(this.pool, tenant, async (client) => {
      // Une invitation expirée ne bloque pas une nouvelle invitation.
      await client.query(
        `DELETE FROM organization_invitations
         WHERE organization_id = $1 AND lower(email) = lower($2)
           AND accepted_at IS NULL AND expires_at <= now()`,
        [tenant.organizationId, email],
      );
      const result = await client.query<Invitation>(
        `INSERT INTO organization_invitations (organization_id, email, role, invited_by, expires_at)
         VALUES ($1, lower($2), $3, $4, now() + make_interval(days => $5))
         RETURNING id, email, role, created_at AS "createdAt", expires_at AS "expiresAt"`,
        [tenant.organizationId, email, role, tenant.userId, INVITATION_DAYS],
      );
      return result.rows[0]!;
    }).catch(translate);
  }

  revokeInvitation(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        `DELETE FROM organization_invitations
         WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL`,
        [id, tenant.organizationId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async setSso(tenant: TenantContext, alias: string | null, defaultRole: "member" | "reader") {
    await withTenant(this.pool, tenant, (client) =>
      client.query("SELECT snowfall_set_organization_sso($1, $2)", [alias ?? "", defaultRole]),
    ).catch(translate);
  }
}

/** Rattachement à la connexion (invitation ou SSO) : voir snowfall_provision_identity. */
export async function provisionIdentity(
  pool: Pool,
  input: { issuer: string; subject: string; email?: string | undefined; emailVerified: boolean; ssoAliases: string[] },
): Promise<{ userId: string | null; joined: number }> {
  const result = await pool.query<{ user_id: string | null; joined: number }>(
    "SELECT user_id, joined FROM snowfall_provision_identity($1, $2, $3, $4, $5)",
    [input.issuer, input.subject, input.email ?? null, input.emailVerified, input.ssoAliases],
  );
  const row = result.rows[0];
  return { userId: row?.user_id ?? null, joined: row?.joined ?? 0 };
}
