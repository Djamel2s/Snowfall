import type { FastifyRequest } from "fastify";
import type {} from "@fastify/cookie";
import type { Pool } from "pg";
import type { AuditLog } from "../audit/audit.js";
import type { SessionStore, UserProfile } from "./session-store.js";

export const organizationRoles = [
  "owner",
  "admin",
  "member",
  "reader",
] as const;

export type OrganizationRole = (typeof organizationRoles)[number];

export type AuthenticatedUser = {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  profile?: UserProfile;
};

export type Authenticator = (
  request: FastifyRequest,
) => Promise<AuthenticatedUser | null>;

export type Membership = { organizationId: string; role: string };

export interface IdentityDirectory {
  findUserId(issuer: string, subject: string): Promise<string | null>;
  memberships(userId: string): Promise<Membership[]>;
}

export class PostgresIdentityDirectory implements IdentityDirectory {
  constructor(private readonly pool: Pool) {}

  async findUserId(issuer: string, subject: string) {
    const result = await this.pool.query<{ user_id: string }>(
      "SELECT user_id FROM external_identities WHERE issuer = $1 AND subject = $2",
      [issuer, subject],
    );
    return result.rows[0]?.user_id ?? null;
  }

  async memberships(userId: string) {
    const result = await this.pool.query<{ organization_id: string; role: string }>(
      `SELECT organization_id, role FROM organization_members
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId],
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      role: row.role,
    }));
  }
}

/**
 * L'organisation active vient de l'en-tête x-organization-id mais n'est
 * acceptée que si l'utilisateur en est membre en base. Sans en-tête, seul un
 * utilisateur mono-organisation est résolu : jamais de choix implicite.
 */
export function selectMembership(
  memberships: Membership[],
  requestedOrganization: unknown,
): { organizationId: string; role: OrganizationRole } | null {
  const membership =
    typeof requestedOrganization === "string" && requestedOrganization !== ""
      ? memberships.find((item) => item.organizationId === requestedOrganization)
      : memberships.length === 1
        ? memberships[0]
        : undefined;

  if (!membership || !organizationRoles.includes(membership.role as OrganizationRole)) {
    return null;
  }

  return {
    organizationId: membership.organizationId,
    role: membership.role as OrganizationRole,
  };
}

export function createSessionAuthenticator(deps: {
  cookieName: string;
  sessions: SessionStore;
  directory: IdentityDirectory;
  audit: AuditLog;
}): Authenticator {
  return async (request) => {
    let resolution;
    try {
      resolution = await deps.sessions.resolve(request.cookies[deps.cookieName]);
    } catch (error) {
      // Panne IdP/DB : on refuse (fail closed) sans détruire la session.
      request.log.error({ err: error }, "Échec de validation de session");
      return null;
    }

    if (resolution.status === "missing") return null;

    if (resolution.status === "ended") {
      await deps.audit.record(request, {
        eventType: "auth.session_ended",
        outcome: resolution.reason === "revoked" ? "denied" : "success",
        actorUserId: resolution.userId,
        details: { reason: resolution.reason },
      });
      return null;
    }

    const { session } = resolution;
    const membership = selectMembership(
      await deps.directory.memberships(session.userId),
      request.headers["x-organization-id"],
    );

    if (!membership) {
      await deps.audit.record(request, {
        eventType: "auth.organization_access",
        outcome: "denied",
        actorUserId: session.userId,
        details: {
          requestedOrganization:
            typeof request.headers["x-organization-id"] === "string"
              ? request.headers["x-organization-id"].slice(0, 64)
              : "",
        },
      });
      return null;
    }

    return { userId: session.userId, ...membership, profile: session.profile };
  };
}
