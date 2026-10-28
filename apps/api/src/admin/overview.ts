import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";
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
      return {
        ...activity,
        tokens: fillMonths(tokens.rows.map((row) => ({ period: row.period, provider: row.provider, tokens: Number(row.tokens) }))),
        tools: Object.fromEntries(tools.rows.filter((row) => toolMeters.includes(row.meter)).map((row) => [row.meter, Number(row.calls)])),
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
      };
    }
    return { ...data, days: data.days.slice(-days), agents: data.agents.filter((agent) => agent.users >= AGENT_MIN_USERS) };
  }
}
