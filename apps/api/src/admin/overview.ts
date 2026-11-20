import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { spendOf, type ModelUsage, type Prices } from "../workspace/costs.js";
import { currentPeriod, toolMeters, type ToolMeter } from "../workspace/settings.js";

// Pilotage (Administration) : des TOTAUX de l'organisation, jamais un classement
// par personne. L'activité vient de snowfall_admin_overview() (table de comptage
// sans contenu, administrateurs seulement) ; l'usage d'un agent n'y figure qu'à
// partir de AGENT_MIN_USERS personnes distinctes.

export const AGENT_MIN_USERS = 5;
export const OVERVIEW_PERIODS = [7, 30, 90] as const;
/** Mois de consommation affichés (mois courant compris). */
export const TOKEN_MONTHS = 6;

export type AdminActivity = {
  days: { day: string; users: number; messages: number }[];
  active7: number;
  active30: number;
  activePeriod: number;
  agents: { agentId: string; messages: number; users: number }[];
};

export type AdminOverviewData = AdminActivity & {
  /** Jetons (entrée + sortie) par mois et par fournisseur, du plus ancien au plus récent. */
  tokens: { period: string; byProvider: Record<string, number> }[];
  /** Appels d'outils du mois courant. */
  tools: Partial<Record<ToolMeter, number>>;
  /** Pour les coûts en euros (calculés aux tarifs actuels) : jetons par modèle et appels d'outils, par mois. */
  usage: (ModelUsage & { period: string })[];
  toolCalls: { period: string; meter: ToolMeter; calls: number }[];
};

export class AdminForbiddenError extends Error {
  constructor() {
    super("ADMIN_FORBIDDEN");
  }
}

export interface AdminOverviewStore {
  overview(tenant: TenantContext, days: number): Promise<AdminOverviewData>;
}

/** Premier jour du mois, `back` mois avant le mois courant (UTC). */
export function monthsBack(back: number, now = new Date()) {
  return currentPeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)));
}

/** Coût de chaque mois (six points), aux tarifs actuels ; modèles sans tarif signalés par mois. */
export function monthlyCosts(data: Pick<AdminOverviewData, "usage" | "toolCalls">, prices: Prices, now = new Date()) {
  return Array.from({ length: TOKEN_MONTHS }, (_, index) => {
    const period = monthsBack(TOKEN_MONTHS - 1 - index, now);
    const tools: Partial<Record<ToolMeter, number>> = {};
    for (const row of data.toolCalls) if (row.period === period) tools[row.meter] = (tools[row.meter] ?? 0) + row.calls;
    const spend = spendOf(data.usage.filter((row) => row.period === period), tools, prices);
    return { period, euros: Math.round(spend.euros * 100) / 100, unpriced: spend.unpriced };
  });
}

/** Mois manquants remplis à zéro : la courbe garde ses six points. */
function fillMonths(rows: { period: string; provider: string; tokens: number }[], now = new Date()) {
  return Array.from({ length: TOKEN_MONTHS }, (_, index) => {
    const period = monthsBack(TOKEN_MONTHS - 1 - index, now);
    const byProvider = Object.fromEntries(rows.filter((row) => row.period === period).map((row) => [row.provider, row.tokens]));
    return { period, byProvider };
  });
}

export class PostgresAdminOverviewStore implements AdminOverviewStore {
  constructor(private readonly pool: Pool) {}

  overview(tenant: TenantContext, days: number) {
    return withTenant(this.pool, tenant, async (client) => {
      let activity: AdminActivity;
      try {
        activity = (await client.query<{ overview: AdminActivity }>("SELECT snowfall_admin_overview($1) AS overview", [days])).rows[0]!.overview;
      } catch (error) {
        if ((error as { code?: string }).code === "42501") throw new AdminForbiddenError();
        throw error;
      }
      const tokens = await client.query<{ period: string; provider: string; tokens: string }>(
        `SELECT to_char(period, 'YYYY-MM-DD') AS period, provider, sum(input_tokens + output_tokens) AS tokens
         FROM token_usage WHERE organization_id = $1 AND period >= $2 AND provider <> 'echo'
         GROUP BY 1, 2`,
        [tenant.organizationId, monthsBack(TOKEN_MONTHS - 1)],
      );
      const tools = await client.query<{ meter: ToolMeter; calls: string }>(
        "SELECT meter, sum(calls) AS calls FROM tool_usage WHERE organization_id = $1 AND period = $2 GROUP BY 1",
        [tenant.organizationId, currentPeriod()],
      );
      const usage = await client.query<{ period: string; provider: ModelUsage["provider"]; model: string; input: string; output: string }>(
        `SELECT to_char(period, 'YYYY-MM-DD') AS period, provider, model, sum(input_tokens) AS input, sum(output_tokens) AS output
         FROM token_usage WHERE organization_id = $1 AND period >= $2 AND provider <> 'echo'
         GROUP BY 1, 2, 3`,
        [tenant.organizationId, monthsBack(TOKEN_MONTHS - 1)],
      );
      const toolCalls = await client.query<{ period: string; meter: ToolMeter; calls: string }>(
        `SELECT to_char(period, 'YYYY-MM-DD') AS period, meter, sum(calls) AS calls
         FROM tool_usage WHERE organization_id = $1 AND period >= $2 GROUP BY 1, 2`,
        [tenant.organizationId, monthsBack(TOKEN_MONTHS - 1)],
      );
      return {
        ...activity,
        tokens: fillMonths(tokens.rows.map((row) => ({ period: row.period, provider: row.provider, tokens: Number(row.tokens) }))),
        tools: Object.fromEntries(tools.rows.filter((row) => toolMeters.includes(row.meter)).map((row) => [row.meter, Number(row.calls)])),
        usage: usage.rows.map((row) => ({ period: row.period, provider: row.provider, model: row.model, inputTokens: Number(row.input), outputTokens: Number(row.output) })),
        toolCalls: toolCalls.rows.filter((row) => toolMeters.includes(row.meter)).map((row) => ({ period: row.period, meter: row.meter, calls: Number(row.calls) })),
      };
    });
  }
}

/** Développement et tests : activité fournie, mêmes règles (administrateurs, seuil de 5 personnes). */
export class MemoryAdminOverviewStore implements AdminOverviewStore {
  constructor(
    private readonly data: Record<string, Omit<AdminOverviewData, "agents"> & { agents: AdminActivity["agents"] }> = {},
    private readonly admins: (tenant: TenantContext) => boolean = () => true,
  ) {}

  async overview(tenant: TenantContext, days: number): Promise<AdminOverviewData> {
    if (!this.admins(tenant)) throw new AdminForbiddenError();
    const data = this.data[tenant.organizationId];
    if (!data) {
      const today = new Date();
      return {
        days: Array.from({ length: days }, (_, index) => ({ day: new Date(today.getTime() - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10), users: 0, messages: 0 })),
        active7: 0,
        active30: 0,
        activePeriod: 0,
        agents: [],
        tokens: fillMonths([]),
        tools: {},
        usage: [],
        toolCalls: [],
      };
    }
    return { ...data, days: data.days.slice(-days), agents: data.agents.filter((agent) => agent.users >= AGENT_MIN_USERS) };
  }
}
