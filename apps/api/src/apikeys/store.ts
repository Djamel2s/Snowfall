import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Clés d'API : une application tierce appelle les agents de l'organisation.
// - La clé n'est montrée qu'une fois ; seule son empreinte SHA-256 est gardée
//   (256 bits d'aléa : pas besoin d'un hachage lent, rien à deviner).
// - Une clé agit au nom de l'administrateur qui l'a créée (RLS, audit, quotas),
//   et seulement tant qu'il est administrateur : rétrogradé ou parti, elle s'arrête.
// - Elle ne sert qu'aux routes /v1, pour les agents listés, jusqu'à son expiration.
// - Une clé SCIM (« snowfall_scim_… ») sert seulement au provisionnement des
//   comptes (/scim/v2), sans agent ; une clé d'API n'y sert pas, et inversement.

export type ApiKeyKind = "api" | "scim";
export const API_KEY_PATTERN = /^snowfall_(sk|scim)_[A-Za-z0-9]{46}$/;
const PREFIX: Record<ApiKeyKind, string> = { api: "snowfall_sk_", scim: "snowfall_scim_" };
export const MAX_KEY_AGENTS = 20;
export const MAX_KEY_DAYS = 365;

export type ApiKey = {
  id: string;
  name: string;
  /** Début de la clé, pour la reconnaître (jamais assez pour l'utiliser). */
  prefix: string;
  /** Administrateur au nom duquel la clé agit. */
  createdBy: string;
  kind: ApiKeyKind;
  agentIds: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** Ce qu'une clé valide permet (le reste vient du compte de son créateur). */
export type ApiKeyPrincipal = { keyId: string; organizationId: string; userId: string; role: "owner" | "admin"; kind: ApiKeyKind };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Caractères alphanumériques uniformes (tirage avec rejet : aucun biais). */
function randomAlphanumeric(length: number) {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

export const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

/** Nouvelle clé : 46 caractères alphanumériques après le préfixe fixe (≈ 270 bits d'aléa). */
export function newApiKey(kind: ApiKeyKind = "api") {
  const key = `${PREFIX[kind]}${randomAlphanumeric(46)}`;
  return { key, prefix: key.slice(0, PREFIX[kind].length + 6), hash: hashKey(key) };
}

export type NewApiKey = { name: string; agentIds: string[]; expiresAt: Date; kind?: ApiKeyKind | undefined };

export interface ApiKeyStore {
  list(tenant: TenantContext): Promise<ApiKey[]>;
  /** null : refusé (pas administrateur). */
  create(tenant: TenantContext, input: NewApiKey): Promise<{ key: string; record: ApiKey } | null>;
  revoke(tenant: TenantContext, id: string): Promise<boolean>;
  /** Clé présentée par une application : valide et son créateur toujours administrateur. */
  authenticate(key: string): Promise<ApiKeyPrincipal | null>;
  /** Agents permis à la clé ; note l'usage (au plus une fois par minute). */
  agentsFor(principal: ApiKeyPrincipal): Promise<string[] | null>;
}

type Row = {
  id: string;
  name: string;
  prefix: string;
  userId: string;
  kind: ApiKeyKind;
  agentIds: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

const iso = (value: string | Date | null) => (value === null ? null : new Date(value).toISOString());
const view = (row: Row): ApiKey => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  createdBy: row.userId,
  kind: row.kind,
  agentIds: row.agentIds,
  expiresAt: iso(row.expiresAt)!,
  lastUsedAt: iso(row.lastUsedAt),
  revokedAt: iso(row.revokedAt),
  createdAt: iso(row.createdAt)!,
});

const COLUMNS = `id, name, prefix, user_id AS "userId", kind, agent_ids AS "agentIds", expires_at AS "expiresAt",
  last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt"`;

export class PostgresApiKeyStore implements ApiKeyStore {
  constructor(private readonly pool: Pool) {}

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) =>
      (await client.query<Row>(`SELECT ${COLUMNS} FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC`, [tenant.organizationId])).rows.map(view),
    );
  }

  create(tenant: TenantContext, input: NewApiKey) {
    return withTenant(this.pool, tenant, async (client) => {
      const admin = await client.query<{ ok: boolean }>("SELECT snowfall_is_admin() AS ok");
      if (!admin.rows[0]?.ok) return null;
      const kind = input.kind ?? "api";
      const { key, prefix, hash } = newApiKey(kind);
      const row = (
        await client.query<Row>(
          `INSERT INTO api_keys (id, organization_id, user_id, name, prefix, key_hash, agent_ids, expires_at, kind)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
          [randomUUID(), tenant.organizationId, tenant.userId, input.name, prefix, hash, input.agentIds, input.expiresAt, kind],
        )
      ).rows[0]!;
      return { key, record: view(row) };
    });
  }

  revoke(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL", [id, tenant.organizationId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async authenticate(key: string) {
    if (!API_KEY_PATTERN.test(key)) return null;
    const client = await this.pool.connect();
    try {
      const row = (
        await client.query<ApiKeyPrincipal>(
          `SELECT key_id AS "keyId", organization_id AS "organizationId", user_id AS "userId", role, kind FROM snowfall_api_key_lookup($1)`,
          [hashKey(key)],
        )
      ).rows[0];
      return row ?? null;
    } finally {
      client.release();
    }
  }

  agentsFor(principal: ApiKeyPrincipal) {
    return withTenant(this.pool, principal, async (client) => {
      const row = (
        await client.query<{ agentIds: string[] }>(
          `UPDATE api_keys SET last_used_at = now()
           WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL AND expires_at > now()
             AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
           RETURNING agent_ids AS "agentIds"`,
          [principal.keyId, principal.organizationId],
        )
      ).rows[0];
      if (row) return row.agentIds;
      // Déjà notée il y a moins d'une minute : simple lecture.
      const read = (
        await client.query<{ agentIds: string[] }>(
          `SELECT agent_ids AS "agentIds" FROM api_keys WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
          [principal.keyId, principal.organizationId],
        )
      ).rows[0];
      return read?.agentIds ?? null;
    });
  }
}

/** En mémoire : développement sans base, tests. `roleOf` : rôle actuel d'un membre. */
export class MemoryApiKeyStore implements ApiKeyStore {
  private readonly items: (ApiKey & { organizationId: string; hash: string })[] = [];

  constructor(private readonly roleOf: (tenant: TenantContext) => Promise<string | null> | string | null = () => "admin") {}

  private async admin(tenant: TenantContext) {
    const role = await this.roleOf(tenant);
    return role === "owner" || role === "admin";
  }

  async list(tenant: TenantContext) {
    if (!(await this.admin(tenant))) return [];
    return this.items.filter((item) => item.organizationId === tenant.organizationId).map(({ organizationId: _o, hash: _h, ...item }) => item);
  }

  async create(tenant: TenantContext, input: NewApiKey) {
    if (!(await this.admin(tenant))) return null;
    const kind = input.kind ?? "api";
    const { key, prefix, hash } = newApiKey(kind);
    const now = new Date().toISOString();
    const record: ApiKey = { id: randomUUID(), name: input.name, prefix, createdBy: tenant.userId, kind, agentIds: input.agentIds, expiresAt: input.expiresAt.toISOString(), lastUsedAt: null, revokedAt: null, createdAt: now };
    this.items.unshift({ ...record, organizationId: tenant.organizationId, hash });
    return { key, record };
  }

  async revoke(tenant: TenantContext, id: string) {
    if (!(await this.admin(tenant))) return false;
    const item = this.items.find((entry) => entry.id === id && entry.organizationId === tenant.organizationId && !entry.revokedAt);
    if (!item) return false;
    item.revokedAt = new Date().toISOString();
    return true;
  }

  async authenticate(key: string) {
    if (!API_KEY_PATTERN.test(key)) return null;
    const item = this.items.find((entry) => entry.hash === hashKey(key));
    if (!item || item.revokedAt || Date.parse(item.expiresAt) <= Date.now()) return null;
    const tenant = { organizationId: item.organizationId, userId: item.createdBy };
    const role = await this.roleOf(tenant);
    return role === "owner" || role === "admin" ? { keyId: item.id, ...tenant, role: role as ApiKeyPrincipal["role"], kind: item.kind } : null;
  }

  async agentsFor(principal: ApiKeyPrincipal) {
    const item = this.items.find((entry) => entry.id === principal.keyId && entry.organizationId === principal.organizationId);
    if (!item || item.revokedAt || Date.parse(item.expiresAt) <= Date.now()) return null;
    item.lastUsedAt = new Date().toISOString();
    return item.agentIds;
  }
}
