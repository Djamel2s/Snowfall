import type { Pool, PoolClient } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { embeddingProviders, type EmbeddingProvider } from "../knowledge/embeddings.js";
import { keyProviders, type KeyProvider } from "../llm/keys.js";
import { providerIds, type ProviderId } from "../llm/types.js";
import { defaultOrganizationTools, knownTools, type ToolId } from "../agent/catalog.js";
import { emptyPrices, pricesOf, spendOf, type ModelUsage, type Prices, type Spend } from "./costs.js";

export type OrganizationSettings = {
  allowedProviders: ProviderId[];
  /** Fournisseurs pour lesquels un membre peut utiliser sa propre clé ; vide = aucun (défaut). */
  personalKeyProviders: KeyProvider[];
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
  /** Tarifs saisis par l'administrateur (coûts en euros). */
  prices: Prices;
  /** Budget mensuel de l'organisation, en euros (jetons et outils) ; null = illimité. */
  monthlyBudget: number | null;
  /** Budget mensuel de chaque membre, en euros ; null = illimité. */
  memberMonthlyBudget: number | null;
  /** Plafonds mensuels d'appels d'outils de chaque membre ; absent = illimité. */
  memberToolLimits: Partial<Record<ToolMeter, number>>;
  /** Plafonds d'une réponse (jamais au-delà de ceux de la plateforme) ; null = ceux de la plateforme. */
  responseMaxTokens: number | null;
  responseMaxSeconds: number | null;
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
  /** Appels du mois du membre courant (plafonds par membre). */
  memberToolUsage(tenant: TenantContext): Promise<Partial<Record<ToolMeter, number>>>;
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
  async memberToolUsage(tenant: TenantContext) {
    const usage: Partial<Record<ToolMeter, number>> = {};
    for (const meter of toolMeters) {
      const value = this.counts.get(`${tenant.organizationId}:${currentPeriod()}:${meter}:${tenant.userId}`);
      if (value) usage[meter] = value;
    }
    return usage;
  }
  async recordTool(tenant: TenantContext, meter: ToolMeter) {
    for (const key of [`${tenant.organizationId}:${currentPeriod()}:${meter}`, `${tenant.organizationId}:${currentPeriod()}:${meter}:${tenant.userId}`]) {
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
  }
}

export const defaultSettings: OrganizationSettings = {
  allowedProviders: [...providerIds],
  personalKeyProviders: [],
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
  prices: emptyPrices,
  monthlyBudget: null,
  memberMonthlyBudget: null,
  memberToolLimits: {},
  responseMaxTokens: null,
  responseMaxSeconds: null,
};

export type UsageTotals = { inputTokens: number; outputTokens: number };

export type UsageSummary = {
  period: string;
  total: UsageTotals;
  byProvider: Partial<Record<ProviderId | "echo", UsageTotals>>;
  /** Consommation du membre courant. */
  mine: UsageTotals;
  /** Dépenses du mois en euros (organisation, membre courant), aux tarifs actuels. Absent : non calculées. */
  spend?: { organization: Spend; mine: Spend };
  /** Jetons de l'organisation par modèle, et appels d'outils (page des coûts, administrateurs). */
  models?: ModelUsage[];
  tools?: Partial<Record<ToolMeter, number>>;
};

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: "provider_not_allowed" | "quota_exceeded" | "provider_quota_exceeded" | "budget_exceeded" | "member_budget_exceeded" };

export interface SettingsStore {
  get(tenant: TenantContext): Promise<OrganizationSettings>;
  update(tenant: TenantContext, settings: OrganizationSettings): Promise<OrganizationSettings>;
  usage(tenant: TenantContext): Promise<UsageSummary>;
  /** Consommation détaillée par membre (vue d'administration). */
  usageByMember(tenant: TenantContext): Promise<{ userId: string; tokens: number }[]>;
  /** Jetons consommés, comptés par modèle (coûts) ; modèle inconnu : chaîne vide (tarif du fournisseur). */
  record(tenant: TenantContext, provider: ProviderId | "echo", usage: UsageTotals, model?: string): Promise<void>;
}

export const tokens = (usage: UsageTotals | undefined) =>
  (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

/**
 * Décision avant génération. Le dépassement est vérifié avant l'appel : une
 * réponse en cours peut légèrement dépasser le plafond, jamais la suivante.
 */
/** Qui paie une réponse : l'organisation, ou le membre (sa clé personnelle). */
export type Billing = "organization" | "personal";

export function checkQuota(
  settings: OrganizationSettings,
  usage: UsageSummary,
  provider: ProviderId | "echo",
  billing: Billing = "organization",
): QuotaDecision {
  if (provider !== "echo" && !settings.allowedProviders.includes(provider)) {
    return { allowed: false, reason: "provider_not_allowed" };
  }
  // Clé personnelle : ni les plafonds ni les budgets de l'organisation (ce n'est pas elle qui paie).
  if (billing === "personal") return { allowed: true };
  if (settings.monthlyTokenLimit !== null && tokens(usage.total) >= settings.monthlyTokenLimit) {
    return { allowed: false, reason: "quota_exceeded" };
  }
  const providerLimit = provider === "echo" ? undefined : settings.providerTokenLimits[provider];
  if (providerLimit !== undefined && tokens(usage.byProvider[provider]) >= providerLimit) {
    return { allowed: false, reason: "provider_quota_exceeded" };
  }
  return checkBudget(settings, usage);
}

/**
 * Budgets en euros (jetons et outils) : vérifiés avant une réponse ET avant
 * chaque appel d'outil compté. Une réponse en cours peut dépasser de peu ;
 * jamais la suivante.
 */
export function checkBudget(settings: Pick<OrganizationSettings, "monthlyBudget" | "memberMonthlyBudget">, usage: Pick<UsageSummary, "spend">): QuotaDecision {
  if (!usage.spend) return { allowed: true };
  if (settings.monthlyBudget !== null && usage.spend.organization.euros >= settings.monthlyBudget) return { allowed: false, reason: "budget_exceeded" };
  if (settings.memberMonthlyBudget !== null && usage.spend.mine.euros >= settings.memberMonthlyBudget) return { allowed: false, reason: "member_budget_exceeded" };
  return { allowed: true };
}

type SettingsRow = {
  allowed_providers: string[];
  personal_key_providers: string[];
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
  prices: unknown;
  monthly_budget_cents: string | null;
  member_budget_cents: string | null;
  member_tool_limits: Record<string, unknown>;
  response_max_tokens: number | null;
  response_max_seconds: number | null;
};

const positiveLimits = (value: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(
    toolMeters.flatMap((meter) => {
      const limit = value?.[meter];
      return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? [[meter, limit]] : [];
    }),
  ) as Partial<Record<ToolMeter, number>>;

const euros = (cents: string | null) => (cents === null ? null : Number(cents) / 100);

/** Lignes (fournisseur, modèle) fusionnées : la requête les sépare par membre. */
function mergeModels(rows: ModelUsage[]) {
  const merged = new Map<string, ModelUsage>();
  for (const row of rows) {
    const key = `${row.provider}:${row.model}`;
    const current = merged.get(key);
    if (current) {
      current.inputTokens += row.inputTokens;
      current.outputTokens += row.outputTokens;
    } else merged.set(key, { ...row });
  }
  return [...merged.values()];
}

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
    personalKeyProviders: keyProviders.filter((id) => (row.personal_key_providers ?? []).includes(id)),
    monthlyTokenLimit: row.monthly_token_limit === null ? null : Number(row.monthly_token_limit),
    providerTokenLimits: limits,
    embeddingProvider: embeddingProviders.find((id) => id === row.embedding_provider) ?? null,
    linksEnabled: row.links_enabled,
    linkDomains: row.link_domains,
    tools: knownTools(row.enabled_tools),
    toolLimits: positiveLimits(row.tool_limits),
    modelRouting: routingOf(row.model_routing),
    // Toute valeur inattendue : protégé (jamais « off » par défaut).
    sensitiveData: row.sensitive_data === "off" ? "off" : "local",
    pseudonymize: row.pseudonymize === true,
    prices: pricesOf(row.prices),
    monthlyBudget: euros(row.monthly_budget_cents),
    memberMonthlyBudget: euros(row.member_budget_cents),
    memberToolLimits: positiveLimits(row.member_tool_limits),
    responseMaxTokens: row.response_max_tokens,
    responseMaxSeconds: row.response_max_seconds,
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
              embedding_provider, links_enabled, link_domains, enabled_tools, tool_limits, model_routing, sensitive_data, pseudonymize,
              prices, monthly_budget_cents, member_budget_cents, member_tool_limits, response_max_tokens, response_max_seconds,
              personal_key_providers
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
            embedding_provider, links_enabled, link_domains, enabled_tools, tool_limits, updated_by, model_routing, sensitive_data, pseudonymize,
            prices, monthly_budget_cents, member_budget_cents, member_tool_limits, response_max_tokens, response_max_seconds, personal_key_providers, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now())
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
           prices = EXCLUDED.prices,
           monthly_budget_cents = EXCLUDED.monthly_budget_cents,
           member_budget_cents = EXCLUDED.member_budget_cents,
           member_tool_limits = EXCLUDED.member_tool_limits,
           response_max_tokens = EXCLUDED.response_max_tokens,
           response_max_seconds = EXCLUDED.response_max_seconds,
           personal_key_providers = EXCLUDED.personal_key_providers,
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
          JSON.stringify(settings.prices),
          settings.monthlyBudget === null ? null : Math.round(settings.monthlyBudget * 100),
          settings.memberMonthlyBudget === null ? null : Math.round(settings.memberMonthlyBudget * 100),
          settings.memberToolLimits,
          settings.responseMaxTokens,
          settings.responseMaxSeconds,
          settings.personalKeyProviders,
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
        model: string;
        mine: boolean;
        input: string;
        output: string;
      }>(
        `SELECT provider, model, user_id = $3 AS mine,
                sum(input_tokens) AS input, sum(output_tokens) AS output
         FROM token_usage
         WHERE organization_id = $1 AND period = $2
         GROUP BY provider, model, user_id = $3`,
        [tenant.organizationId, period, tenant.userId],
      );
      const toolRows = await client.query<{ meter: ToolMeter; mine: boolean; calls: string }>(
        `SELECT meter, user_id = $3 AS mine, sum(calls) AS calls FROM tool_usage
         WHERE organization_id = $1 AND period = $2 GROUP BY meter, user_id = $3`,
        [tenant.organizationId, period, tenant.userId],
      );
      const prices = (await this.read(client, tenant)).prices;

      const summary: UsageSummary = {
        period,
        total: { inputTokens: 0, outputTokens: 0 },
        byProvider: {},
        mine: { inputTokens: 0, outputTokens: 0 },
      };
      const models: { organization: ModelUsage[]; mine: ModelUsage[] } = { organization: [], mine: [] };
      for (const row of result.rows) {
        const input = Number(row.input);
        const output = Number(row.output);
        const usage = { provider: row.provider, model: row.model, inputTokens: input, outputTokens: output };
        models.organization.push(usage);
        if (row.mine) models.mine.push(usage);
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
      const tools: { organization: Partial<Record<ToolMeter, number>>; mine: Partial<Record<ToolMeter, number>> } = { organization: {}, mine: {} };
      for (const row of toolRows.rows) {
        if (!toolMeters.includes(row.meter)) continue;
        tools.organization[row.meter] = (tools.organization[row.meter] ?? 0) + Number(row.calls);
        if (row.mine) tools.mine[row.meter] = (tools.mine[row.meter] ?? 0) + Number(row.calls);
      }
      summary.spend = { organization: spendOf(models.organization, tools.organization, prices), mine: spendOf(models.mine, tools.mine, prices) };
      summary.models = mergeModels(models.organization);
      summary.tools = tools.organization;
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

  memberToolUsage(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ meter: ToolMeter; calls: number }>(
        "SELECT meter, calls FROM tool_usage WHERE organization_id = $1 AND period = $2 AND user_id = $3",
        [tenant.organizationId, currentPeriod(), tenant.userId],
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

  record(tenant: TenantContext, provider: ProviderId | "echo", usage: UsageTotals, model = "") {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query(
        `INSERT INTO token_usage (organization_id, user_id, provider, period, input_tokens, output_tokens, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, period, provider, model, user_id) DO UPDATE SET
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
          // Identifiant de modèle borné (vient de la configuration ou du catalogue du fournisseur).
          /^[\w.:/@-]{1,120}$/.test(model) ? model : "",
        ],
      );
    });
  }
}
