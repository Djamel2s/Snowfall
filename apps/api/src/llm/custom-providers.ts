import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { API_KEY_PATTERN, keyHint } from "./keys.js";

// Fournisseurs personnalisés : un serveur compatible OpenAI (OpenRouter, Groq,
// Together, Azure…) ajouté par un administrateur pour son organisation.
// - Adresse HTTPS publique, vérifiée à l'ajout ET avant chaque appel (anti-SSRF) ;
//   les serveurs internes restent ceux de la plateforme (fournisseur « local »).
// - Clé facultative, chiffrée ; l'AAD lie la clé à l'organisation, au fournisseur
//   ET à son adresse : changer l'adresse en base ne détourne pas la clé.
// - Les modèles sont publiés sous le fournisseur « custom », nommés « <id>/<modèle> ».

/** Au plus 20 fournisseurs personnalisés par organisation. */
export const MAX_CUSTOM_PROVIDERS = 20;

export type CustomProviderInfo = { id: string; name: string; baseUrl: string; hint: string | null; createdAt: string };
export type CustomEndpoint = { id: string; name: string; baseUrl: string; apiKey?: string | undefined };

export interface CustomProviderStore {
  /** Métadonnées : jamais la clé. */
  list(tenant: TenantContext): Promise<CustomProviderInfo[]>;
  /** Adresse et clé en clair, pour le serveur seulement. */
  endpoints(tenant: TenantContext): Promise<CustomEndpoint[]>;
  create(tenant: TenantContext, input: { name: string; baseUrl: string; apiKey?: string | undefined }): Promise<string>;
  remove(tenant: TenantContext, id: string): Promise<boolean>;
}

export const customProviderAad = (organizationId: string, id: string, baseUrl: string) => `model-provider:${organizationId}:${id}:${baseUrl}`;

/** Sélection d'un modèle personnalisé : « <id du fournisseur>/<modèle> ». */
export function splitCustomModel(model: string): { endpointId: string; model: string } | null {
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) return null;
  return { endpointId: model.slice(0, index), model: model.slice(index + 1) };
}

/**
 * fetch d'un fournisseur personnalisé : HTTPS seulement, adresse publique vérifiée
 * avant CHAQUE appel (le nom peut changer d'adresse après l'ajout), aucune
 * redirection suivie (sinon un serveur public renverrait vers le réseau interne).
 * Résiduel : entre la vérification et la connexion, le DNS peut changer ; en
 * production la sortie passe par le proxy, qui refuse lui-même les adresses internes.
 */
export function guardedFetch(checkAddress: (hostname: string) => Promise<void>, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") throw new Error("INVALID_URL");
    await checkAddress(url.hostname);
    return base(input, { ...init, redirect: "error" });
  };
}

type Row = { id: string; name: string; baseUrl: string; apiKey: string | null; hint: string | null; createdAt: Date };

function checkInput(input: { name: string; baseUrl: string; apiKey?: string | undefined }) {
  if (!input.name || input.name.length > 60) throw new Error("INVALID_NAME");
  if (!input.baseUrl.startsWith("https://") || input.baseUrl.length > 500) throw new Error("INVALID_URL");
  if (input.apiKey !== undefined && !API_KEY_PATTERN.test(input.apiKey)) throw new Error("INVALID_API_KEY");
}

export class PostgresCustomProviderStore implements CustomProviderStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private rows(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<Row>(
        `SELECT id, name, base_url AS "baseUrl", api_key AS "apiKey", hint, created_at AS "createdAt"
         FROM organization_model_providers WHERE organization_id = $1 ORDER BY created_at, id`,
        [tenant.organizationId],
      );
      return result.rows;
    });
  }

  async list(tenant: TenantContext) {
    return (await this.rows(tenant)).map((row) => ({ id: row.id, name: row.name, baseUrl: row.baseUrl, hint: row.hint, createdAt: new Date(row.createdAt).toISOString() }));
  }

  endpoints(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<Row>(
        `SELECT id, name, base_url AS "baseUrl", api_key AS "apiKey" FROM organization_model_providers WHERE organization_id = $1 ORDER BY created_at, id`,
        [tenant.organizationId],
      );
      const endpoints: CustomEndpoint[] = [];
      for (const row of result.rows) {
        const apiKey = row.apiKey ? await this.keyring.decrypt(client, tenant.organizationId, row.apiKey, customProviderAad(tenant.organizationId, row.id, row.baseUrl)) : undefined;
        endpoints.push({ id: row.id, name: row.name, baseUrl: row.baseUrl, apiKey });
      }
      return endpoints;
    });
  }

  create(tenant: TenantContext, input: { name: string; baseUrl: string; apiKey?: string | undefined }) {
    checkInput(input);
    return withTenant(this.pool, tenant, async (client) => {
      // Verrou de l'organisation : deux ajouts simultanés ne dépassent pas la limite.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('model-providers:' || $1))", [tenant.organizationId]);
      const count = await client.query<{ count: string }>("SELECT count(*) AS count FROM organization_model_providers WHERE organization_id = $1", [tenant.organizationId]);
      if (Number(count.rows[0]?.count ?? 0) >= MAX_CUSTOM_PROVIDERS) throw new Error("TOO_MANY_PROVIDERS");
      const id = randomUUID();
      const apiKey = input.apiKey ? await this.keyring.encrypt(client, tenant.organizationId, input.apiKey, customProviderAad(tenant.organizationId, id, input.baseUrl)) : null;
      await client.query(
        `INSERT INTO organization_model_providers (id, organization_id, name, base_url, api_key, hint, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenant.organizationId, input.name, input.baseUrl, apiKey, input.apiKey ? keyHint(input.apiKey) : null, tenant.userId],
      );
      return id;
    });
  }

  remove(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM organization_model_providers WHERE organization_id = $1 AND id = $2", [tenant.organizationId, id]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}

/** Tests et développement sans base. */
export class MemoryCustomProviderStore implements CustomProviderStore {
  private readonly items = new Map<string, CustomEndpoint & { organizationId: string; createdAt: string }>();

  private of(tenant: TenantContext) {
    return [...this.items.values()].filter((item) => item.organizationId === tenant.organizationId);
  }

  async list(tenant: TenantContext) {
    return this.of(tenant).map((item) => ({ id: item.id, name: item.name, baseUrl: item.baseUrl, hint: item.apiKey ? keyHint(item.apiKey) : null, createdAt: item.createdAt }));
  }

  async endpoints(tenant: TenantContext) {
    return this.of(tenant).map(({ id, name, baseUrl, apiKey }) => ({ id, name, baseUrl, apiKey }));
  }

  async create(tenant: TenantContext, input: { name: string; baseUrl: string; apiKey?: string | undefined }) {
    checkInput(input);
    if (this.of(tenant).length >= MAX_CUSTOM_PROVIDERS) throw new Error("TOO_MANY_PROVIDERS");
    const id = randomUUID();
    this.items.set(id, { id, organizationId: tenant.organizationId, name: input.name, baseUrl: input.baseUrl, apiKey: input.apiKey, createdAt: new Date().toISOString() });
    return id;
  }

  async remove(tenant: TenantContext, id: string) {
    const item = this.items.get(id);
    if (!item || item.organizationId !== tenant.organizationId) return false;
    return this.items.delete(id);
  }
}
