import type { Pool } from "pg";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { AdminForbiddenError } from "./overview.js";

// Administration › Sécurité : durée de conservation des conversations, et
// lecture du journal d'audit. Le rôle applicatif n'écrit que dans
// audit_events ; un administrateur lit celui de SON organisation par
// snowfall_audit_log() (rôle vérifié en base).

/** Durées proposées (jours) ; null : sans limite. */
export const RETENTION_CHOICES = [30, 90, 180, 365, 730, 1095] as const;
export const AUDIT_PAGE = 50;
export const AUDIT_EXPORT_MAX = 5_000;

export type AuditEntry = {
  id: string;
  occurredAt: string;
  eventType: string;
  outcome: "success" | "failure" | "denied";
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: Record<string, unknown>;
};

export type AuditQuery = { before?: { at: string; id: string } | undefined; limit: number; categories?: string[] | undefined; problems?: boolean | undefined };

export type ExpiredConversation = { conversationId: string; organizationId: string; userId: string };

export interface SecurityStore {
  retention(tenant: TenantContext): Promise<number | null>;
  /** false : refusé par la base (pas administrateur). */
  setRetention(tenant: TenantContext, days: number | null): Promise<boolean>;
  audit(tenant: TenantContext, query: AuditQuery): Promise<AuditEntry[]>;
  /** Conversations sans activité depuis la durée de leur organisation (purge, sans utilisateur). */
  expired(): Promise<ExpiredConversation[]>;
}

type AuditRow = { id: string; occurred_at: Date; event_type: string; outcome: AuditEntry["outcome"]; actor_user_id: string | null; target_type: string | null; target_id: string | null; ip: string | null; details: Record<string, unknown> };

export class PostgresSecurityStore implements SecurityStore {
  constructor(private readonly pool: Pool) {}

  retention(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<{ conversation_days: number | null }>("SELECT conversation_days FROM organization_retention WHERE organization_id = $1", [tenant.organizationId])).rows[0];
      return row?.conversation_days ?? null;
    });
  }

  setRetention(tenant: TenantContext, days: number | null) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        `INSERT INTO organization_retention (organization_id, conversation_days, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id) DO UPDATE SET conversation_days = EXCLUDED.conversation_days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tenant.organizationId, days, tenant.userId],
      );
      return (result.rowCount ?? 0) > 0;
    }).catch((error: unknown) => {
      if ((error as { code?: string }).code === "42501") return false;
      throw error;
    });
  }

  audit(tenant: TenantContext, query: AuditQuery) {
    return withTenant(this.pool, tenant, async (client) => {
      try {
        const rows = (
          await client.query<AuditRow>("SELECT * FROM snowfall_audit_log($1, $2, $3, $4, $5)", [
            query.before?.at ?? null,
            query.before?.id ?? null,
            query.limit,
            query.categories?.length ? query.categories : null,
            query.problems ?? false,
          ])
        ).rows;
        return rows.map((row) => ({
          id: row.id,
          occurredAt: row.occurred_at.toISOString(),
          eventType: row.event_type,
          outcome: row.outcome,
          actorUserId: row.actor_user_id,
          targetType: row.target_type,
          targetId: row.target_id,
          ip: row.ip,
          details: row.details ?? {},
        }));
      } catch (error) {
        if ((error as { code?: string }).code === "42501") throw new AdminForbiddenError();
        throw error;
      }
    });
  }

  async expired() {
    const rows = (await this.pool.query<{ conversation_id: string; organization_id: string; user_id: string }>("SELECT conversation_id, organization_id, user_id FROM snowfall_retention_expired()")).rows;
    return rows.map((row) => ({ conversationId: row.conversation_id, organizationId: row.organization_id, userId: row.user_id }));
  }
}

/** Développement et tests : mêmes règles (administrateurs, organisation, ordre, pages). */
export class MemorySecurityStore implements SecurityStore {
  readonly days = new Map<string, number | null>();
  constructor(
    readonly events: (AuditEntry & { organizationId: string })[] = [],
    private readonly isAdmin: (tenant: TenantContext) => boolean = () => true,
    readonly expiredList: ExpiredConversation[] = [],
  ) {}

  async retention(tenant: TenantContext) {
    return this.days.get(tenant.organizationId) ?? null;
  }

  async setRetention(tenant: TenantContext, days: number | null) {
    if (!this.isAdmin(tenant)) return false;
    this.days.set(tenant.organizationId, days);
    return true;
  }

  async audit(tenant: TenantContext, query: AuditQuery) {
    if (!this.isAdmin(tenant)) throw new AdminForbiddenError();
    return this.events
      .filter((event) => event.organizationId === tenant.organizationId)
      .filter((event) => !query.categories?.length || query.categories.includes(event.eventType.split(".")[0]!))
      .filter((event) => !query.problems || event.outcome !== "success")
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
      .filter((event) => !query.before || event.occurredAt < query.before.at || (event.occurredAt === query.before.at && event.id < query.before.id))
      .slice(0, query.limit)
      .map(({ organizationId: _organization, ...event }) => event);
  }

  async expired() {
    return this.expiredList.splice(0);
  }
}
