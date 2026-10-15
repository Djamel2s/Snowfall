import type { Pool, PoolClient } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { providerIds, type ProviderId } from "../llm/types.js";

export type OrganizationSettings = {
  allowedProviders: ProviderId[];
  /** Plafond mensuel de tokens (entrée + sortie) ; null = illimité. */
  monthlyTokenLimit: number | null;
  providerTokenLimits: Partial<Record<ProviderId, number>>;
};

export const defaultSettings: OrganizationSettings = {
  allowedProviders: [...providerIds],
  monthlyTokenLimit: null,
  providerTokenLimits: {},
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
};

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
  };
}

/** Premier jour du mois courant (UTC), clé de période de token_usage. */
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export class PostgresSettingsStore implements SettingsStore {
  constructor(private readonly pool: Pool) {}

  private async read(client: PoolClient, tenant: TenantContext) {
    const result = await client.query<SettingsRow>(
      `SELECT allowed_providers, monthly_token_limit, provider_token_limits
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
           (organization_id, allowed_providers, monthly_token_limit, provider_token_limits, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (organization_id) DO UPDATE SET
           allowed_providers = EXCLUDED.allowed_providers,
           monthly_token_limit = EXCLUDED.monthly_token_limit,
           provider_token_limits = EXCLUDED.provider_token_limits,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [
          tenant.organizationId,
          settings.allowedProviders,
          settings.monthlyTokenLimit,
          settings.providerTokenLimits,
          tenant.userId,
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
