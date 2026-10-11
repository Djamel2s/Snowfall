import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPool } from "../db/pool.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config({
  path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
});

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
};

export type Authenticator = (
  request: FastifyRequest,
) => Promise<AuthenticatedUser | null>;

const issuer = process.env.OIDC_ISSUER;
const audience = process.env.OIDC_AUDIENCE;

const jwks = issuer
  ? createRemoteJWKSet(
      new URL(
        `${issuer.replace(/\/$/, "")}/protocol/openid-connect/certs`,
      ),
    )
  : null;

export const authenticateWithKeycloak: Authenticator = async (request) => {
  if (!issuer || !audience || !jwks) {
    return null;
  }

  const authorization = request.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: ["RS256"],
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    const result = await getPool().query<{
      user_id: string;
      organization_id: string;
      role: string;
    }>(
      `SELECT ei.user_id, om.organization_id, om.role
       FROM external_identities ei
       JOIN organization_members om ON om.user_id = ei.user_id
       WHERE ei.issuer = $1 AND ei.subject = $2
       ORDER BY om.created_at ASC
       LIMIT 2`,
      [issuer, payload.sub],
    );

    if (result.rows.length !== 1) {
      return null;
    }

    const membership = result.rows[0];

    if (
      !membership ||
      !organizationRoles.includes(membership.role as OrganizationRole)
    ) {
      return null;
    }

    return {
      userId: membership.user_id,
      organizationId: membership.organization_id,
      role: membership.role as OrganizationRole,
    };
  } catch {
    return null;
  }
};