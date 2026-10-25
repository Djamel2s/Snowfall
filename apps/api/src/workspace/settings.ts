import type { Pool, PoolClient } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { embeddingProviders, type EmbeddingProvider } from "../knowledge/embeddings.js";
import { providerIds, type ProviderId } from "../llm/types.js";
import { defaultOrganizationTools, knownTools, type ToolId } from "../agent/catalog.js";

export type OrganizationSettings = {
  allowedProviders: ProviderId[];
  /** Plafond mensuel de tokens (entrée + sortie) ; null = illimité. */
  monthlyTokenLimit: number | null;
  providerTokenLimits: Partial<Record<ProviderId, number>>;
  /** Embeddings des bases de connaissances ; null = mots-clés seulement (rien ne sort). */
  embeddingProvider: EmbeddingProvider | null;
  /** Import de pages web dans les bases de connaissances. */
  linksEnabled: boolean;
  /** Domaines autorisés pour les liens ; vide = tout domaine public. */
  linkDomains: string[];
  /** Outils d'agent disponibles dans l'organisation. */
  tools: ToolId[];
  /** Plafonds mensuels d'appels d'outils, par catégorie ; absent = illimité. */
  toolLimits: Partial<Record<ToolMeter, number>>;
  /** Routage automatique : question simple → modèle rapide, complexe → modèle puissant ; null = désactivé. */
  modelRouting: ModelRouting | null;
  /** Données sensibles détectées avant un envoi externe : modèle local, ou refus. « off » : désactivé. */
  sensitiveData: "local" | "off";
  /** Données personnelles remplacées par des jetons avant un fournisseur externe (restituées au retour). */
  pseudonymize: boolean;
};

export type ModelRouting = { fast: { provider: ProviderId; model: string }; strong: { provider: ProviderId; model: string } };

/**
 * Catégories d'outils comptées : leur coût n'apparaît pas dans les tokens
 * (calcul dans le bac à sable, requêtes au moteur de recherche, service tiers).
 */
export const toolMeters = ["code", "web", "mcp", "image"] as const;
export type ToolMeter = (typeof toolMeters)[number];

/** Catégorie d'un outil exposé au modèle (null : non compté). */
export function meterOf(toolName: string): ToolMeter | null {
  // Script de compétence : même bac à sable, même plafond (sinon un contournement du quota).
  if (toolName === "run_code" || toolName === "run_skill_script") return "code";
  if (toolName === "generate_image") return "image";
  if (toolName === "web_search" || toolName === "read_webpage") return "web";
  if (toolName.startsWith("mcp_")) return "mcp";
  return null;
}

/** Appels d'outils du mois, pour toute l'organisation. */
export interface ToolUsageStore {
  toolUsage(tenant: TenantContext): Promise<Partial<Record<ToolMeter, number>>>;
  recordTool(tenant: TenantContext, meter: ToolMeter): Promise<void>;
}

/** En mémoire : développement sans base, tests. */
export class MemoryToolUsageStore implements ToolUsageStore {
  private readonly counts = new Map<string, number>();
  async toolUsage(tenant: TenantContext) {
    const usage: Partial<Record<ToolMeter, number>> = {};
    for (const meter of toolMeters) {
      const value = this.counts.get(`${tenant.organizationId}:${currentPeriod()}:${meter}`);
      if (value) usage[meter] = value;
    }
    return usage;
  }
  async recordTool(tenant: TenantContext, meter: ToolMeter) {
    const key = `${tenant.organizationId}:${currentPeriod()}:${meter}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

export const defaultSettings: OrganizationSettings = {
  allowedProviders: [...providerIds],
  monthlyTokenLimit: null,
  providerTokenLimits: {},
  embeddingProvider: null,
  linksEnabled: true,
  linkDomains: [],
  tools: defaultOrganizationTools,
  toolLimits: {},
  modelRouting: null,
  sensitiveData: "local",
  pseudonymize: false,
};

export type UsageTotals = { inputTokens: number; outputTokens: number };

export type UsageSummary = {
  period: string;
  total: UsageTotals;
  byProvider: Partial<Record<ProviderId | "echo", UsageTotals>>;
  /** Consommation du membre courant. */
  mine: UsageTotals;
};

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: "provider_not_allowed" | "quota_exceeded" | "provider_quota_exceeded" };

export interface SettingsStore {
  get(tenant: TenantContext): Promise<OrganizationSettings>;
  update(tenant: TenantContext, settings: OrganizationSettings): Promise<OrganizationSettings>;
  usage(tenant: TenantContext): Promise<UsageSummary>;
  /** Consommation détaillée par membre (vue d'administration). */
  usageByMember(tenant: TenantContext): Promise<{ userId: string; tokens: number }[]>;
  record(tenant: TenantContext, provider: ProviderId | "echo", usage: UsageTotals): Promise<void>;
}

export const tokens = (usage: UsageTotals | undefined) =>
  (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

/**
 * Décision avant génération. Le dépassement est vérifié avant l'appel : une
 * réponse en cours peut légèrement dépasser le plafond, jamais la suivante.
 */
export function checkQuota(
  settings: OrganizationSettings,
  usage: UsageSummary,
  provider: ProviderId | "echo",
): QuotaDecision {
  if (provider !== "echo" && !settings.allowedProviders.includes(provider)) {
    return { allowed: false, reason: "provider_not_allowed" };
  }
  if (settings.monthlyTokenLimit !== null && tokens(usage.total) >= settings.monthlyTokenLimit) {
    return { allowed: false, reason: "quota_exceeded" };
  }
  const providerLimit = provider === "echo" ? undefined : settings.providerTokenLimits[provider];
  if (providerLimit !== undefined && tokens(usage.byProvider[provider]) >= providerLimit) {
    return { allowed: false, reason: "provider_quota_exceeded" };
  }
  return { allowed: true };
}

type SettingsRow = {
  allowed_providers: string[];
  monthly_token_limit: string | null;
  provider_token_limits: Record<string, unknown>;
  embedding_provider: string | null;
  links_enabled: boolean;
  link_domains: string[];
  enabled_tools: string[];
  tool_limits: Record<string, unknown>;
  model_routing: unknown;
  sensitive_data: string;
  pseudonymize: boolean;
};

const isSelection = (value: unknown): value is { provider: ProviderId; model: string } =>
  typeof value === "object" && value !== null && providerIds.includes((value as { provider: ProviderId }).provider) && typeof (value as { model: unknown }).model === "string";

function routingOf(value: unknown): ModelRouting | null {
  if (typeof value !== "object" || value === null) return null;
  const { fast, strong } = value as { fast?: unknown; strong?: unknown };
  return isSelection(fast) && isSelection(strong) ? { fast: { provider: fast.provider, model: fast.model }, strong: { provider: strong.provider, model: strong.model } } : null;
}

function fromRow(row: SettingsRow | undefined): OrganizationSettings {
  if (!row) return defaultSettings;
  const limits: Partial<Record<ProviderId, number>> = {};
  for (const id of providerIds) {
    const value = row.provider_token_limits[id];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) limits[id] = value;
  }
  return {
    allowedProviders: providerIds.filter((id) => row.allowed_providers.includes(id)),
    monthlyTokenLimit: row.monthly_token_limit === null ? null : Number(row.monthly_token_limit),
    providerTokenLimits: limits,
    embeddingProvider: embeddingProviders.find((id) => id === row.embedding_provider) ?? null,
    linksEnabled: row.links_enabled,
    linkDomains: row.link_domains,
    tools: knownTools(row.enabled_tools),
    toolLimits: Object.fromEntries(
      toolMeters.flatMap((meter) => {
        const value = row.tool_limits?.[meter];
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? [[meter, value]] : [];
      }),
    ),
    modelRouting: routingOf(row.model_routing),
    // Toute valeur inattendue : protégé (jamais « off » par défaut).
    sensitiveData: row.sensitive_data === "off" ? "off" : "local",
    pseudonymize: row.pseudonymize === true,
  };
}

/** Premier jour du mois courant (UTC), clé de période de token_usage. */
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export class PostgresSettingsStore implements SettingsStore, ToolUsageStore {
  constructor(private readonly pool: Pool) {}

  private async read(client: PoolClient, tenant: TenantContext) {
    const result = await client.query<SettingsRow>(
      `SELECT allowed_providers, monthly_token_limit, provider_token_limits,
              embedding_provider, links_enabled, link_domains, enabled_tools, tool_limits, model_routing, sensitive_data, pseudonymize
       FROM organization_settings WHERE organization_id = $1`,
      [tenant.organizationId],
    );
    return fromRow(result.rows[0]);
  }

  get(tenant: TenantContext) {
    return withTenant(this.pool, tenant, (client) => this.read(client, tenant));
  }

  update(tenant: TenantContext, settings: OrganizationSettings) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query(
        `INSERT INTO organization_settings
           (organization_id, allowed_providers, monthly_token_limit, provider_token_limits,
            embedding_provider, links_enabled, link_domains, enabled_tools, tool_limits, updated_by, model_routing, sensitive_data, pseudonymize, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
         ON CONFLICT (organization_id) DO UPDATE SET
           allowed_providers = EXCLUDED.allowed_providers,
           monthly_token_limit = EXCLUDED.monthly_token_limit,
           provider_token_limits = EXCLUDED.provider_token_limits,
           embedding_provider = EXCLUDED.embedding_provider,
           links_enabled = EXCLUDED.links_enabled,
           link_domains = EXCLUDED.link_domains,
           enabled_tools = EXCLUDED.enabled_tools,
           tool_limits = EXCLUDED.tool_limits,
           model_routing = EXCLUDED.model_routing,
           sensitive_data = EXCLUDED.sensitive_data,
           pseudonymize = EXCLUDED.pseudonymize,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [
          tenant.organizationId,
          settings.allowedProviders,
          settings.monthlyTokenLimit,
          settings.providerTokenLimits,
          settings.embeddingProvider,
          settings.linksEnabled,
          settings.linkDomains,
          settings.tools,
          settings.toolLimits,
          tenant.userId,
          settings.modelRouting ? JSON.stringify(settings.modelRouting) : null,
          settings.sensitiveData,
          settings.pseudonymize,
        ],
      );
      return this.read(client, tenant);
    });
  }

  usage(tenant: TenantContext) {
    const period = currentPeriod();
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{
        provider: ProviderId | "echo";
        mine: boolean;
        input: string;
        output: string;
      }>(
        `SELECT provider, user_id = $3 AS mine,
                sum(input_tokens) AS input, sum(output_tokens) AS output
         FROM token_usage
         WHERE organization_id = $1 AND period = $2
         GROUP BY provider, user_id = $3`,
        [tenant.organizationId, period, tenant.userId],
      );

      const summary: UsageSummary = {
        period,
        total: { inputTokens: 0, outputTokens: 0 },
        byProvider: {},
        mine: { inputTokens: 0, outputTokens: 0 },
      };
      for (const row of result.rows) {
        const input = Number(row.input);
        const output = Number(row.output);
        summary.total.inputTokens += input;
        summary.total.outputTokens += output;
        const provider = (summary.byProvider[row.provider] ??= { inputTokens: 0, outputTokens: 0 });
        provider.inputTokens += input;
        provider.outputTokens += output;
        if (row.mine) {
          summary.mine.inputTokens += input;
          summary.mine.outputTokens += output;
        }
      }
      return summary;
    });
  }

  usageByMember(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ user_id: string; tokens: string }>(
        `SELECT user_id, sum(input_tokens + output_tokens) AS tokens
         FROM token_usage
         WHERE organization_id = $1 AND period = $2
         GROUP BY user_id`,
        [tenant.organizationId, currentPeriod()],
      );
      return result.rows.map((row) => ({ userId: row.user_id, tokens: Number(row.tokens) }));
    });
  }

  toolUsage(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ meter: ToolMeter; calls: string }>(
        `SELECT meter, sum(calls) AS calls FROM tool_usage
         WHERE organization_id = $1 AND period = $2
         GROUP BY meter`,
        [tenant.organizationId, currentPeriod()],
      );
      return Object.fromEntries(result.rows.map((row) => [row.meter, Number(row.calls)])) as Partial<Record<ToolMeter, number>>;
    });
  }

  recordTool(tenant: TenantContext, meter: ToolMeter) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query(
        `INSERT INTO tool_usage (organization_id, user_id, meter, period, calls)
         VALUES ($1, $2, $3, $4, 1)
         ON CONFLICT (organization_id, period, meter, user_id) DO UPDATE SET
           calls = tool_usage.calls + 1, updated_at = now()`,
        [tenant.organizationId, tenant.userId, meter, currentPeriod()],
      );
    });
  }

  record(tenant: TenantContext, provider: ProviderId | "echo", usage: UsageTotals) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query(
        `INSERT INTO token_usage (organization_id, user_id, provider, period, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, period, provider, user_id) DO UPDATE SET
           input_tokens = token_usage.input_tokens + EXCLUDED.input_tokens,
           output_tokens = token_usage.output_tokens + EXCLUDED.output_tokens,
           updated_at = now()`,
        [
          tenant.organizationId,
          tenant.userId,
          provider,
          currentPeriod(),
          Math.max(0, Math.floor(usage.inputTokens)),
          Math.max(0, Math.floor(usage.outputTokens)),
        ],
      );
    });
  }
}
