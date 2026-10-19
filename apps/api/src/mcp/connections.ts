import type { Pool } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { OAuthTokens } from "./oauth.js";

// Connexions personnelles aux serveurs MCP en mode OAuth : jetons de
// l'utilisateur (chiffrés, lisibles par lui seul) et demandes de connexion en
// cours (state et secret PKCE, à usage unique, 10 minutes).

export type PendingAuthorization = { serverId: string; verifier: string };

export interface McpConnectionStore {
  tokens(tenant: TenantContext, serverId: string): Promise<OAuthTokens | null>;
  saveTokens(tenant: TenantContext, serverId: string, tokens: OAuthTokens): Promise<void>;
  deleteTokens(tenant: TenantContext, serverId: string): Promise<boolean>;
  /** Serveurs auxquels l'utilisateur est connecté. */
  connected(tenant: TenantContext): Promise<string[]>;
  savePending(tenant: TenantContext, stateHash: string, pending: PendingAuthorization): Promise<void>;
  /** Lit ET efface la demande (usage unique) ; null si inconnue ou expirée. */
  takePending(tenant: TenantContext, stateHash: string): Promise<PendingAuthorization | null>;
}

export const PENDING_TTL_MS = 10 * 60 * 1000;

export const tokenAad = (tenant: TenantContext, serverId: string, field: "access" | "refresh") => `mcp-user-token-${field}:${tenant.organizationId}:${tenant.userId}:${serverId}`;
export const verifierAad = (tenant: TenantContext, stateHash: string) => `mcp-oauth-verifier:${tenant.organizationId}:${tenant.userId}:${stateHash}`;

export class PostgresMcpConnectionStore implements McpConnectionStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  tokens(tenant: TenantContext, serverId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<{ access: string; refresh: string | null; expiresAt: string | null }>(
          `SELECT access_token AS access, refresh_token AS refresh, expires_at AS "expiresAt" FROM mcp_user_tokens
           WHERE server_id = $1 AND organization_id = $2 AND user_id = $3`,
          [serverId, tenant.organizationId, tenant.userId],
        )
      ).rows[0];
      if (!row) return null;
      const refresh = row.refresh ? await this.keyring.decrypt(client, tenant.organizationId, row.refresh, tokenAad(tenant, serverId, "refresh")) : undefined;
      return {
        accessToken: await this.keyring.decrypt(client, tenant.organizationId, row.access, tokenAad(tenant, serverId, "access")),
        ...(refresh ? { refreshToken: refresh } : {}),
        ...(row.expiresAt ? { expiresAt: new Date(row.expiresAt).toISOString() } : {}),
      };
    });
  }

  saveTokens(tenant: TenantContext, serverId: string, tokens: OAuthTokens) {
    return withTenant(this.pool, tenant, async (client) => {
      const access = await this.keyring.encrypt(client, tenant.organizationId, tokens.accessToken, tokenAad(tenant, serverId, "access"));
      const refresh = tokens.refreshToken ? await this.keyring.encrypt(client, tenant.organizationId, tokens.refreshToken, tokenAad(tenant, serverId, "refresh")) : null;
      await client.query(
        `INSERT INTO mcp_user_tokens (server_id, organization_id, user_id, access_token, refresh_token, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (server_id, user_id) DO UPDATE SET access_token = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, mcp_user_tokens.refresh_token), expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [serverId, tenant.organizationId, tenant.userId, access, refresh, tokens.expiresAt ?? null],
      );
    });
  }

  deleteTokens(tenant: TenantContext, serverId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM mcp_user_tokens WHERE server_id = $1 AND organization_id = $2 AND user_id = $3", [serverId, tenant.organizationId, tenant.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  connected(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (await client.query<{ serverId: string }>(`SELECT server_id AS "serverId" FROM mcp_user_tokens WHERE organization_id = $1 AND user_id = $2`, [tenant.organizationId, tenant.userId])).rows;
      return rows.map((row) => row.serverId);
    });
  }

  savePending(tenant: TenantContext, stateHash: string, pending: PendingAuthorization) {
    return withTenant(this.pool, tenant, async (client) => {
      // Demandes expirées de cet utilisateur : effacées au passage.
      await client.query("DELETE FROM mcp_oauth_states WHERE organization_id = $1 AND user_id = $2 AND expires_at < now()", [tenant.organizationId, tenant.userId]);
      const verifier = await this.keyring.encrypt(client, tenant.organizationId, pending.verifier, verifierAad(tenant, stateHash));
      await client.query(
        `INSERT INTO mcp_oauth_states (state_hash, organization_id, user_id, server_id, verifier, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
        [stateHash, tenant.organizationId, tenant.userId, pending.serverId, verifier, PENDING_TTL_MS / 1000],
      );
    });
  }

  takePending(tenant: TenantContext, stateHash: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<{ serverId: string; verifier: string }>(
          `DELETE FROM mcp_oauth_states WHERE state_hash = $1 AND organization_id = $2 AND user_id = $3 AND expires_at > now()
           RETURNING server_id AS "serverId", verifier`,
          [stateHash, tenant.organizationId, tenant.userId],
        )
      ).rows[0];
      if (!row) return null;
      return { serverId: row.serverId, verifier: await this.keyring.decrypt(client, tenant.organizationId, row.verifier, verifierAad(tenant, stateHash)) };
    });
  }
}

/** En mémoire : développement sans base, tests. */
export class MemoryMcpConnectionStore implements McpConnectionStore {
  private readonly saved = new Map<string, OAuthTokens>();
  private readonly pending = new Map<string, PendingAuthorization & { owner: string; expires: number }>();
  private key = (tenant: TenantContext, serverId: string) => `${tenant.organizationId}:${tenant.userId}:${serverId}`;
  private owner = (tenant: TenantContext) => `${tenant.organizationId}:${tenant.userId}`;

  async tokens(tenant: TenantContext, serverId: string) {
    const tokens = this.saved.get(this.key(tenant, serverId));
    return tokens ? { ...tokens } : null;
  }

  async saveTokens(tenant: TenantContext, serverId: string, tokens: OAuthTokens) {
    const previous = this.saved.get(this.key(tenant, serverId));
    this.saved.set(this.key(tenant, serverId), { ...tokens, ...(tokens.refreshToken ?? previous?.refreshToken ? { refreshToken: tokens.refreshToken ?? previous?.refreshToken } : {}) });
  }

  async deleteTokens(tenant: TenantContext, serverId: string) {
    return this.saved.delete(this.key(tenant, serverId));
  }

  async connected(tenant: TenantContext) {
    const prefix = `${this.owner(tenant)}:`;
    return [...this.saved.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }

  async savePending(tenant: TenantContext, stateHash: string, pending: PendingAuthorization) {
    this.pending.set(stateHash, { ...pending, owner: this.owner(tenant), expires: Date.now() + PENDING_TTL_MS });
  }

  async takePending(tenant: TenantContext, stateHash: string) {
    const pending = this.pending.get(stateHash);
    if (!pending || pending.owner !== this.owner(tenant)) return null;
    this.pending.delete(stateHash);
    if (pending.expires < Date.now()) return null;
    return { serverId: pending.serverId, verifier: pending.verifier };
  }
}
