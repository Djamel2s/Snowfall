import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { Cadence } from "./rule.js";

// Agents planifiés : privés à leur auteur (RLS), nom et consigne chiffrés.

export type ScheduleKind = "schedule" | "knowledge";
export type ScheduleStatus = "done" | "paused" | "error" | "skipped";

export type AgentSchedule = {
  id: string;
  agentId: string;
  conversationId: string;
  name: string;
  prompt: string;
  kind: ScheduleKind;
  rule: Cadence | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  checkedAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduleStatus | null;
  failures: number;
  createdAt: string;
};

export type ScheduleInput = { agentId: string; conversationId: string; name: string; prompt: string; kind: ScheduleKind; rule: Cadence | null; timezone: string; nextRunAt: Date | null };
export type ClaimedSchedule = { scheduleId: string; organizationId: string; userId: string; role: AuthenticatedUser["role"] };

/** Par personne : de quoi automatiser une veille, pas une ferme de tâches. */
export const MAX_SCHEDULES_PER_USER = 5;
/** Désactivée après trois échecs de suite (quota, agent indisponible…). */
export const MAX_FAILURES = 3;

export interface ScheduleStore {
  list(tenant: TenantContext): Promise<AgentSchedule[]>;
  get(tenant: TenantContext, id: string): Promise<AgentSchedule | null>;
  /** null : plafond atteint. */
  create(tenant: TenantContext, input: ScheduleInput): Promise<AgentSchedule | null>;
  setEnabled(tenant: TenantContext, id: string, enabled: boolean, nextRunAt: Date | null): Promise<AgentSchedule | null>;
  /** Exécuter dès le prochain passage du planificateur. */
  runSoon(tenant: TenantContext, id: string): Promise<boolean>;
  delete(tenant: TenantContext, id: string): Promise<boolean>;
  /** Tâches dues, prises à bail (toutes organisations ; fonction SQL dédiée). */
  claim(leaseSeconds: number, limit: number): Promise<ClaimedSchedule[]>;
  /** Fin d'un passage : statut, prochaine échéance, bail rendu. */
  finish(tenant: TenantContext, id: string, outcome: { status: ScheduleStatus | null; nextRunAt: Date | null; ran: boolean; checked: boolean }): Promise<void>;
}

export const scheduleAad = (organizationId: string, id: string, field: "name" | "prompt") => `agent-schedule:${organizationId}:${id}:${field}`;

type Row = {
  id: string;
  agent_id: string;
  conversation_id: string;
  name_enc: string;
  prompt_enc: string;
  kind: ScheduleKind;
  cadence: "daily" | "weekly" | null;
  hour: number | null;
  weekday: number | null;
  timezone: string;
  enabled: boolean;
  next_run_at: Date | null;
  checked_at: Date | null;
  last_run_at: Date | null;
  last_status: ScheduleStatus | null;
  failures: number;
  created_at: Date;
};

const COLUMNS = "id, agent_id, conversation_id, name_enc, prompt_enc, kind, cadence, hour, weekday, timezone, enabled, next_run_at, checked_at, last_run_at, last_status, failures, created_at";
const iso = (value: Date | null) => (value ? value.toISOString() : null);

function ruleOf(row: Pick<Row, "cadence" | "hour" | "weekday">): Cadence | null {
  if (row.cadence === "daily" && row.hour !== null) return { cadence: "daily", hour: row.hour };
  if (row.cadence === "weekly" && row.hour !== null && row.weekday !== null) return { cadence: "weekly", hour: row.hour, weekday: row.weekday };
  return null;
}

export class PostgresScheduleStore implements ScheduleStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async view(client: PoolClient, tenant: TenantContext, row: Row): Promise<AgentSchedule> {
    const open = (value: string, field: "name" | "prompt") => this.keyring.decrypt(client, tenant.organizationId, value, scheduleAad(tenant.organizationId, row.id, field));
    return {
      id: row.id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      name: await open(row.name_enc, "name"),
      prompt: await open(row.prompt_enc, "prompt"),
      kind: row.kind,
      rule: ruleOf(row),
      timezone: row.timezone,
      enabled: row.enabled,
      nextRunAt: iso(row.next_run_at),
      checkedAt: iso(row.checked_at),
      lastRunAt: iso(row.last_run_at),
      lastStatus: row.last_status,
      failures: row.failures,
      createdAt: row.created_at.toISOString(),
    };
  }

  list(tenant: TenantContext) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (await client.query<Row>(`SELECT ${COLUMNS} FROM agent_schedules WHERE organization_id = $1 AND user_id = $2 ORDER BY created_at`, [tenant.organizationId, tenant.userId])).rows;
      const schedules: AgentSchedule[] = [];
      for (const row of rows) schedules.push(await this.view(client, tenant, row));
      return schedules;
    });
  }

  get(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<Row>(`SELECT ${COLUMNS} FROM agent_schedules WHERE id = $1 AND organization_id = $2 AND user_id = $3`, [id, tenant.organizationId, tenant.userId])).rows[0];
      return row ? this.view(client, tenant, row) : null;
    });
  }

  create(tenant: TenantContext, input: ScheduleInput) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`agent-schedules:${tenant.organizationId}:${tenant.userId}`]);
      const count = Number((await client.query<{ count: string }>("SELECT count(*) FROM agent_schedules WHERE organization_id = $1 AND user_id = $2", [tenant.organizationId, tenant.userId])).rows[0]!.count);
      if (count >= MAX_SCHEDULES_PER_USER) return null;
      const id = randomUUID();
      const seal = (value: string, field: "name" | "prompt") => this.keyring.encrypt(client, tenant.organizationId, value, scheduleAad(tenant.organizationId, id, field));
      const row = (
        await client.query<Row>(
          `INSERT INTO agent_schedules (id, organization_id, user_id, agent_id, conversation_id, name_enc, prompt_enc, kind, cadence, hour, weekday, timezone, next_run_at, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $8 = 'knowledge' THEN now() END)
           RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, tenant.userId, input.agentId, input.conversationId, await seal(input.name, "name"), await seal(input.prompt, "prompt"), input.kind, input.rule?.cadence ?? null, input.rule?.hour ?? null, input.rule?.cadence === "weekly" ? input.rule.weekday : null, input.timezone, input.nextRunAt],
        )
      ).rows[0]!;
      return this.view(client, tenant, row);
    });
  }

  setEnabled(tenant: TenantContext, id: string, enabled: boolean, nextRunAt: Date | null) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<Row>(
          `UPDATE agent_schedules SET enabled = $4, failures = CASE WHEN $4 THEN 0 ELSE failures END,
             next_run_at = CASE WHEN kind = 'schedule' THEN $5::timestamptz ELSE next_run_at END
           WHERE id = $1 AND organization_id = $2 AND user_id = $3 RETURNING ${COLUMNS}`,
          [id, tenant.organizationId, tenant.userId, enabled, nextRunAt],
        )
      ).rows[0];
      return row ? this.view(client, tenant, row) : null;
    });
  }

  runSoon(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        `UPDATE agent_schedules SET next_run_at = CASE WHEN kind = 'schedule' THEN now() ELSE next_run_at END,
           checked_at = CASE WHEN kind = 'knowledge' THEN NULL ELSE checked_at END
         WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND enabled`,
        [id, tenant.organizationId, tenant.userId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  delete(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM agent_schedules WHERE id = $1 AND organization_id = $2 AND user_id = $3", [id, tenant.organizationId, tenant.userId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async claim(leaseSeconds: number, limit: number) {
    const rows = (
      await this.pool.query<{ schedule_id: string; organization_id: string; user_id: string; role: AuthenticatedUser["role"] }>(
        "SELECT schedule_id, organization_id, user_id, role FROM snowfall_claim_schedules(make_interval(secs => $1), $2)",
        [leaseSeconds, limit],
      )
    ).rows;
    return rows.map((row) => ({ scheduleId: row.schedule_id, organizationId: row.organization_id, userId: row.user_id, role: row.role }));
  }

  finish(tenant: TenantContext, id: string, outcome: { status: ScheduleStatus | null; nextRunAt: Date | null; ran: boolean; checked: boolean }) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query(
        // Bail rendu : une valeur NOUVELLE (maintenant) que le trigger recopie dans la file.
        `UPDATE agent_schedules SET claimed_until = now(),
           next_run_at = CASE WHEN kind = 'schedule' THEN $4::timestamptz ELSE next_run_at END,
           checked_at = CASE WHEN $7 THEN now() ELSE checked_at END,
           last_run_at = CASE WHEN $6 THEN now() ELSE last_run_at END,
           last_status = coalesce($5, last_status),
           failures = CASE WHEN $5 = 'error' THEN failures + 1 WHEN $5 IN ('done', 'paused') THEN 0 ELSE failures END,
           enabled = enabled AND NOT (coalesce($5 = 'error', false) AND failures + 1 >= ${MAX_FAILURES})
         WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
        [id, tenant.organizationId, tenant.userId, outcome.nextRunAt, outcome.status, outcome.ran, outcome.checked],
      );
    });
  }
}

/** Développement et tests : mêmes règles, sans chiffrement ni base. */
export class MemoryScheduleStore implements ScheduleStore {
  private readonly rows: (AgentSchedule & { organizationId: string; userId: string; claimedUntil: number; role: AuthenticatedUser["role"] })[] = [];
  /** Rôle courant de chaque membre (absent : plus membre, jamais exécuté). */
  readonly members = new Map<string, AuthenticatedUser["role"]>();

  private mine(tenant: TenantContext) {
    return this.rows.filter((row) => row.organizationId === tenant.organizationId && row.userId === tenant.userId);
  }
  private strip = ({ organizationId: _o, userId: _u, claimedUntil: _c, role: _r, ...row }: (typeof this.rows)[number]): AgentSchedule => structuredClone(row);

  async list(tenant: TenantContext) {
    return this.mine(tenant).map(this.strip);
  }

  async get(tenant: TenantContext, id: string) {
    const row = this.mine(tenant).find((item) => item.id === id);
    return row ? this.strip(row) : null;
  }

  async create(tenant: TenantContext, input: ScheduleInput) {
    if (this.mine(tenant).length >= MAX_SCHEDULES_PER_USER) return null;
    const row = {
      id: randomUUID(),
      agentId: input.agentId,
      conversationId: input.conversationId,
      name: input.name,
      prompt: input.prompt,
      kind: input.kind,
      rule: input.rule,
      timezone: input.timezone,
      enabled: true,
      nextRunAt: iso(input.nextRunAt),
      checkedAt: input.kind === "knowledge" ? new Date().toISOString() : null,
      lastRunAt: null,
      lastStatus: null,
      failures: 0,
      createdAt: new Date().toISOString(),
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      claimedUntil: 0,
      role: "member" as const,
    };
    this.rows.push(row);
    if (!this.members.has(`${tenant.organizationId}:${tenant.userId}`)) this.members.set(`${tenant.organizationId}:${tenant.userId}`, "member");
    return this.strip(row);
  }

  async setEnabled(tenant: TenantContext, id: string, enabled: boolean, nextRunAt: Date | null) {
    const row = this.mine(tenant).find((item) => item.id === id);
    if (!row) return null;
    row.enabled = enabled;
    if (enabled) row.failures = 0;
    if (row.kind === "schedule") row.nextRunAt = iso(nextRunAt);
    return this.strip(row);
  }

  async runSoon(tenant: TenantContext, id: string) {
    const row = this.mine(tenant).find((item) => item.id === id && item.enabled);
    if (!row) return false;
    if (row.kind === "schedule") row.nextRunAt = new Date().toISOString();
    else row.checkedAt = null;
    return true;
  }

  async delete(tenant: TenantContext, id: string) {
    const index = this.rows.findIndex((row) => row.organizationId === tenant.organizationId && row.userId === tenant.userId && row.id === id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    return true;
  }

  async claim(leaseSeconds: number, limit: number) {
    const now = Date.now();
    const due = this.rows.filter((row) => {
      const member = this.members.get(`${row.organizationId}:${row.userId}`);
      if (!member || !row.enabled || row.claimedUntil > now) return false;
      return row.kind === "schedule" ? Boolean(row.nextRunAt && Date.parse(row.nextRunAt) <= now) : !row.checkedAt || Date.parse(row.checkedAt) < now - 5 * 60_000;
    });
    return due.slice(0, limit).map((row) => {
      row.claimedUntil = now + leaseSeconds * 1000;
      return { scheduleId: row.id, organizationId: row.organizationId, userId: row.userId, role: this.members.get(`${row.organizationId}:${row.userId}`)! };
    });
  }

  async finish(tenant: TenantContext, id: string, outcome: { status: ScheduleStatus | null; nextRunAt: Date | null; ran: boolean; checked: boolean }) {
    const row = this.mine(tenant).find((item) => item.id === id);
    if (!row) return;
    row.claimedUntil = 0;
    if (row.kind === "schedule") row.nextRunAt = iso(outcome.nextRunAt);
    if (outcome.checked) row.checkedAt = new Date().toISOString();
    if (outcome.ran) row.lastRunAt = new Date().toISOString();
    if (outcome.status) row.lastStatus = outcome.status;
    if (outcome.status === "error") {
      row.failures += 1;
      if (row.failures >= MAX_FAILURES) row.enabled = false;
    } else if (outcome.status === "done" || outcome.status === "paused") row.failures = 0;
  }
}
