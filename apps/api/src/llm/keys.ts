import type { Pool } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { ProviderId } from "./types.js";

// Clés d'API des fournisseurs de modèles saisies dans l'interface :
// - clé de l'organisation (un administrateur) : remplace celle de la plateforme ;
// - clé personnelle (un membre, si l'organisation l'autorise pour ce fournisseur) :
//   lisible par lui seul, ses réponses ne comptent pas dans le budget de l'organisation.
// Toujours chiffrées, jamais renvoyées au navigateur : seuls les 4 derniers caractères.
// Pas de serveur « local » : son adresse est fixée par la configuration, jamais par un utilisateur.

export const keyProviders = ["mistral", "openai", "anthropic", "google"] as const satisfies readonly ProviderId[];
export type KeyProvider = (typeof keyProviders)[number];
export type KeyScope = "organization" | "personal";

export const isKeyProvider = (value: string): value is KeyProvider => (keyProviders as readonly string[]).includes(value);

/** Caractères imprimables, sans espace : rien qui puisse casser un en-tête HTTP. */
export const API_KEY_PATTERN = /^[!-~]{8,512}$/;

/** 4 derniers caractères, pour reconnaître sa clé (« ••••abcd »). */
export const keyHint = (apiKey: string) => apiKey.slice(-4).replace(/[^A-Za-z0-9_-]/g, "");

export type ModelKeyInfo = { provider: KeyProvider; hint: string; updatedAt: string };
export type ModelKeySecrets = { organization: Partial<Record<KeyProvider, string>>; personal: Partial<Record<KeyProvider, string>> };

export interface ModelKeyStore {
  /** Métadonnées (fournisseur, indice, date) : jamais la clé. */
  list(tenant: TenantContext): Promise<Record<KeyScope, ModelKeyInfo[]>>;
  /** Clés en clair, pour le serveur seulement (appel au fournisseur). */
  secrets(tenant: TenantContext): Promise<ModelKeySecrets>;
  set(tenant: TenantContext, scope: KeyScope, provider: KeyProvider, apiKey: string): Promise<void>;
  remove(tenant: TenantContext, scope: KeyScope, provider: KeyProvider): Promise<boolean>;
}

export const organizationKeyAad = (organizationId: string, provider: string) => `model-key:organization:${organizationId}:${provider}`;
export const personalKeyAad = (tenant: TenantContext, provider: string) => `model-key:personal:${tenant.organizationId}:${tenant.userId}:${provider}`;

type Row = { provider: KeyProvider; hint: string; updatedAt: Date; apiKey: string };

export class PostgresModelKeyStore implements ModelKeyStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private rows(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const organization = await client.query<Row>(
        `SELECT provider, hint, updated_at AS "updatedAt", api_key AS "apiKey" FROM organization_model_keys WHERE organization_id = $1 ORDER BY provider`,
        [tenant.organizationId],
      );
      const personal = await client.query<Row>(
        `SELECT provider, hint, updated_at AS "updatedAt", api_key AS "apiKey" FROM user_model_keys
         WHERE organization_id = $1 AND user_id = $2 ORDER BY provider`,
        [tenant.organizationId, tenant.userId],
      );
      return { organization: organization.rows.filter((row) => isKeyProvider(row.provider)), personal: personal.rows.filter((row) => isKeyProvider(row.provider)) };
    });
  }

  async list(tenant: TenantContext) {
    const { organization, personal } = await this.rows(tenant);
    const info = (row: Row): ModelKeyInfo => ({ provider: row.provider, hint: row.hint, updatedAt: new Date(row.updatedAt).toISOString() });
    return { organization: organization.map(info), personal: personal.map(info) };
  }

  secrets(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const secrets: ModelKeySecrets = { organization: {}, personal: {} };
      const organization = await client.query<Row>(`SELECT provider, api_key AS "apiKey" FROM organization_model_keys WHERE organization_id = $1`, [tenant.organizationId]);
      for (const row of organization.rows) {
        if (!isKeyProvider(row.provider)) continue;
        secrets.organization[row.provider] = await this.keyring.decrypt(client, tenant.organizationId, row.apiKey, organizationKeyAad(tenant.organizationId, row.provider));
      }
      const personal = await client.query<Row>(`SELECT provider, api_key AS "apiKey" FROM user_model_keys WHERE organization_id = $1 AND user_id = $2`, [
        tenant.organizationId,
        tenant.userId,
      ]);
      for (const row of personal.rows) {
        if (!isKeyProvider(row.provider)) continue;
        secrets.personal[row.provider] = await this.keyring.decrypt(client, tenant.organizationId, row.apiKey, personalKeyAad(tenant, row.provider));
      }
      return secrets;
    });
  }

  set(tenant: TenantContext, scope: KeyScope, provider: KeyProvider, apiKey: string) {
    if (!API_KEY_PATTERN.test(apiKey)) throw new Error("INVALID_API_KEY");
    return withTenant(this.pool, tenant, async (client) => {
      if (scope === "organization") {
        const encrypted = await this.keyring.encrypt(client, tenant.organizationId, apiKey, organizationKeyAad(tenant.organizationId, provider));
        await client.query(
          `INSERT INTO organization_model_keys (organization_id, provider, api_key, hint, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (organization_id, provider) DO UPDATE SET api_key = EXCLUDED.api_key, hint = EXCLUDED.hint,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [tenant.organizationId, provider, encrypted, keyHint(apiKey), tenant.userId],
        );
      } else {
        const encrypted = await this.keyring.encrypt(client, tenant.organizationId, apiKey, personalKeyAad(tenant, provider));
        await client.query(
          `INSERT INTO user_model_keys (organization_id, user_id, provider, api_key, hint, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (organization_id, user_id, provider) DO UPDATE SET api_key = EXCLUDED.api_key, hint = EXCLUDED.hint, updated_at = now()`,
          [tenant.organizationId, tenant.userId, provider, encrypted, keyHint(apiKey)],
        );
      }
    });
  }

  remove(tenant: TenantContext, scope: KeyScope, provider: KeyProvider) {
    return withTenant(this.pool, tenant, async (client) => {
      const result =
        scope === "organization"
          ? await client.query("DELETE FROM organization_model_keys WHERE organization_id = $1 AND provider = $2", [tenant.organizationId, provider])
          : await client.query("DELETE FROM user_model_keys WHERE organization_id = $1 AND user_id = $2 AND provider = $3", [tenant.organizationId, tenant.userId, provider]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}

/** Tests et développement sans base. */
export class MemoryModelKeyStore implements ModelKeyStore {
  private readonly organization = new Map<string, { apiKey: string; updatedAt: string }>();
  private readonly personal = new Map<string, { apiKey: string; updatedAt: string }>();

  private key(tenant: TenantContext, scope: KeyScope, provider: string) {
    return scope === "organization" ? `${tenant.organizationId}:${provider}` : `${tenant.organizationId}:${tenant.userId}:${provider}`;
  }

  private entries(tenant: TenantContext, scope: KeyScope) {
    const map = scope === "organization" ? this.organization : this.personal;
    return keyProviders.flatMap((provider) => {
      const entry = map.get(this.key(tenant, scope, provider));
      return entry ? [{ provider, ...entry }] : [];
    });
  }

  async list(tenant: TenantContext) {
    const info = ({ provider, apiKey, updatedAt }: { provider: KeyProvider; apiKey: string; updatedAt: string }) => ({ provider, hint: keyHint(apiKey), updatedAt });
    return { organization: this.entries(tenant, "organization").map(info), personal: this.entries(tenant, "personal").map(info) };
  }

  async secrets(tenant: TenantContext) {
    const secrets: ModelKeySecrets = { organization: {}, personal: {} };
    for (const scope of ["organization", "personal"] as const) for (const entry of this.entries(tenant, scope)) secrets[scope][entry.provider] = entry.apiKey;
    return secrets;
  }

  async set(tenant: TenantContext, scope: KeyScope, provider: KeyProvider, apiKey: string) {
    if (!API_KEY_PATTERN.test(apiKey)) throw new Error("INVALID_API_KEY");
    (scope === "organization" ? this.organization : this.personal).set(this.key(tenant, scope, provider), { apiKey, updatedAt: new Date().toISOString() });
  }

  async remove(tenant: TenantContext, scope: KeyScope, provider: KeyProvider) {
    return (scope === "organization" ? this.organization : this.personal).delete(this.key(tenant, scope, provider));
  }
}
