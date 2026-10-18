import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Taux de réponses utiles (👍) par agent, pour le catalogue. Agrégat de
// l'organisation seulement, à partir de RATING_MIN_VOTES personnes distinctes (sinon absent).

export type AgentRating = { up: number; total: number };
export const RATING_MIN_VOTES = 5;

export interface AgentRatingStore {
  ratings(tenant: TenantContext): Promise<Record<string, AgentRating>>;
}

export class PostgresAgentRatingStore implements AgentRatingStore {
  constructor(private readonly pool: Pool) {}

  ratings(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (await client.query<{ agent_id: string; up: number; total: number }>("SELECT agent_id, up, total FROM snowfall_agent_ratings()")).rows;
      return Object.fromEntries(rows.map((row) => [row.agent_id, { up: row.up, total: row.total }]));
    });
  }
}

/** Développement et tests : totaux fournis, même seuil qu'en base. */
export class MemoryAgentRatingStore implements AgentRatingStore {
  constructor(private readonly counts: Record<string, Record<string, AgentRating>> = {}) {}

  async ratings(tenant: TenantContext) {
    const mine = this.counts[tenant.organizationId] ?? {};
    return Object.fromEntries(Object.entries(mine).filter(([, rating]) => rating.total >= RATING_MIN_VOTES));
  }
}
