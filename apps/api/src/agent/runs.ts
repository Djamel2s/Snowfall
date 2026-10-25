import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import type { PendingApproval, ToolEvent } from "../graph/chat-graph.js";
import type { Citation } from "../knowledge/service.js";
import type { ModelSelection, ProviderId } from "../llm/types.js";

// Un « run » = une réponse d'agent, indépendante de la connexion HTTP qui l'a
// lancée : elle continue si l'onglet se ferme, se met en pause pour une
// validation, et reprend après un redémarrage (voir server.ts, executeRun).

export type RunKind = "message" | "regenerate" | "continue";
export type RunStatus = "running" | "waiting";

/** Tout ce qu'il faut pour reprendre la réponse et l'enregistrer, même ailleurs. */
export type RunRequest = {
  kind: RunKind;
  content: string;
  attachmentIds: string[];
  editMessageId?: string | undefined;
  /** Régénération : réponse remplacée. */
  previousAssistantId?: string | undefined;
  agentId: string | null;
  selection?: ModelSelection | undefined;
  provider: ProviderId | "echo";
  /** Rôle au lancement (repli si l'annuaire des membres n'est pas disponible). */
  role: string;
  /** Sources injectées d'office (modèle sans outils), pour les citer à la fin. */
  sources?: Citation[] | undefined;
  details: Record<string, string | number | boolean>;
};

/** Avancement visible à la reconnexion. */
export type RunProgress = {
  text: string;
  /** Réflexion du modèle pendant la réponse (jamais gardée avec les messages). */
  reasoning?: string;
  steps: ToolEvent[];
  pending: PendingApproval[];
};

export type RunRecord = {
  id: string;
  conversationId: string;
  status: RunStatus;
  request: RunRequest;
  progress: RunProgress;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  cancelRequested: boolean;
};

export type StaleRun = { runId: string; organizationId: string; userId: string; status: RunStatus };

export const emptyProgress = (): RunProgress => ({ text: "", steps: [], pending: [] });

export interface RunStore {
  /** null : une réponse est déjà en cours dans cette conversation. */
  create(tenant: TenantContext, conversationId: string, request: RunRequest, owner: string, leaseMs: number): Promise<RunRecord | null>;
  get(tenant: TenantContext, id: string): Promise<RunRecord | null>;
  active(tenant: TenantContext, conversationId: string): Promise<RunRecord | null>;
  /**
   * Prend l'exécution : run en attente (validation reçue) ou bail expiré.
   * Atomique : deux instances ne peuvent pas reprendre le même run.
   */
  claim(tenant: TenantContext, id: string, owner: string, leaseMs: number): Promise<RunRecord | null>;
  /** Prolonge le bail ; held=false : une autre instance a repris le run. */
  renew(tenant: TenantContext, id: string, owner: string, leaseMs: number, progress?: RunProgress): Promise<{ held: boolean; cancelRequested: boolean }>;
  /** Pause : attend une validation, bail libéré. */
  pause(tenant: TenantContext, id: string, owner: string, progress: RunProgress): Promise<void>;
  /** Fin (terminé, échoué, annulé) : le run et ses points de reprise sont effacés. */
  finish(tenant: TenantContext, id: string): Promise<void>;
  requestCancel(tenant: TenantContext, id: string): Promise<boolean>;
  /** Runs à reprendre (toutes organisations) : identifiants seulement. */
  stale(waitingTtlSeconds: number): Promise<StaleRun[]>;
}

// ---- Mémoire (développement sans base, tests) -----------------------------

type MemoryRun = RunRecord & TenantContext & { updatedAt: number };

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, MemoryRun>();

  private mine(tenant: TenantContext, id: string) {
    const run = this.runs.get(id);
    return run && run.organizationId === tenant.organizationId && run.userId === tenant.userId ? run : null;
  }

  private view(run: MemoryRun): RunRecord {
    const { organizationId: _org, userId: _user, updatedAt: _at, ...record } = structuredClone(run);
    return record;
  }

  async create(tenant: TenantContext, conversationId: string, request: RunRequest, owner: string, leaseMs: number) {
    if ([...this.runs.values()].some((run) => run.conversationId === conversationId)) return null;
    const run: MemoryRun = {
      id: randomUUID(),
      conversationId,
      status: "running",
      request: structuredClone(request),
      progress: emptyProgress(),
      leaseOwner: owner,
      leaseUntil: new Date(Date.now() + leaseMs),
      cancelRequested: false,
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      updatedAt: Date.now(),
    };
    this.runs.set(run.id, run);
    return this.view(run);
  }

  async get(tenant: TenantContext, id: string) {
    const run = this.mine(tenant, id);
    return run ? this.view(run) : null;
  }

  async active(tenant: TenantContext, conversationId: string) {
    const run = [...this.runs.values()].find((item) => item.conversationId === conversationId && this.mine(tenant, item.id));
    return run ? this.view(run) : null;
  }

  async claim(tenant: TenantContext, id: string, owner: string, leaseMs: number) {
    const run = this.mine(tenant, id);
    const free = run && (run.status === "waiting" || !run.leaseUntil || run.leaseUntil.getTime() < Date.now());
    if (!run || !free) return null;
    Object.assign(run, { status: "running", leaseOwner: owner, leaseUntil: new Date(Date.now() + leaseMs), updatedAt: Date.now() });
    return this.view(run);
  }

  async renew(tenant: TenantContext, id: string, owner: string, leaseMs: number, progress?: RunProgress) {
    const run = this.mine(tenant, id);
    if (!run || run.leaseOwner !== owner || run.status !== "running") return { held: false, cancelRequested: false };
    run.leaseUntil = new Date(Date.now() + leaseMs);
    run.updatedAt = Date.now();
    if (progress) run.progress = structuredClone(progress);
    return { held: true, cancelRequested: run.cancelRequested };
  }

  async pause(tenant: TenantContext, id: string, owner: string, progress: RunProgress) {
    const run = this.mine(tenant, id);
    if (!run || run.leaseOwner !== owner) return;
    Object.assign(run, { status: "waiting", leaseOwner: null, leaseUntil: null, progress: structuredClone(progress), updatedAt: Date.now() });
  }

  async finish(tenant: TenantContext, id: string) {
    if (this.mine(tenant, id)) this.runs.delete(id);
  }

  async requestCancel(tenant: TenantContext, id: string) {
    const run = this.mine(tenant, id);
    if (!run) return false;
    run.cancelRequested = true;
    return true;
  }

  async stale(waitingTtlSeconds: number) {
    const now = Date.now();
    return [...this.runs.values()]
      .filter((run) =>
        run.status === "running"
          ? !run.leaseUntil || run.leaseUntil.getTime() < now
          : run.updatedAt < now - waitingTtlSeconds * 1000,
      )
      .map((run) => ({ runId: run.id, organizationId: run.organizationId, userId: run.userId, status: run.status }));
  }
}

// ---- PostgreSQL (production) -----------------------------------------------

type RunRow = {
  id: string;
  conversation_id: string;
  status: RunStatus;
  request: string;
  progress: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
  cancel_requested: boolean;
};

const COLUMNS = "id, conversation_id, status, request, progress, lease_owner, lease_until, cancel_requested";

/** Runs sous RLS (propriétaire seul) ; demande et avancement chiffrés. */
/** AAD d'un run (exportée pour la rotation des clés). */
export const runAad = (tenant: TenantContext, id: string, field: "request" | "progress") => `agent-run-${field}:${tenant.organizationId}:${tenant.userId}:${id}`;

export class PostgresRunStore implements RunStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private aad(tenant: TenantContext, id: string, field: "request" | "progress") {
    return runAad(tenant, id, field);
  }

  private seal(client: PoolClient, tenant: TenantContext, id: string, field: "request" | "progress", value: unknown) {
    return this.keyring.encrypt(client, tenant.organizationId, JSON.stringify(value), this.aad(tenant, id, field));
  }

  private async toRecord(client: PoolClient, tenant: TenantContext, row: RunRow): Promise<RunRecord> {
    const open = async (field: "request" | "progress", value: string) =>
      JSON.parse(await this.keyring.decrypt(client, tenant.organizationId, value, this.aad(tenant, row.id, field))) as unknown;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status,
      request: (await open("request", row.request)) as RunRequest,
      progress: row.progress ? ((await open("progress", row.progress)) as RunProgress) : emptyProgress(),
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until,
      cancelRequested: row.cancel_requested,
    };
  }

  create(tenant: TenantContext, conversationId: string, request: RunRequest, owner: string, leaseMs: number) {
    return withTenant(this.pool, tenant, async (client) => {
      const id = randomUUID();
      const result = await client.query<RunRow>(
        `INSERT INTO agent_runs (id, organization_id, user_id, conversation_id, kind, request, lease_owner, lease_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
         ON CONFLICT DO NOTHING
         RETURNING ${COLUMNS}`,
        [id, tenant.organizationId, tenant.userId, conversationId, request.kind, await this.seal(client, tenant, id, "request", request), owner, leaseMs / 1000],
      );
      const row = result.rows[0];
      return row ? this.toRecord(client, tenant, row) : null;
    });
  }

  get(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<RunRow>(`SELECT ${COLUMNS} FROM agent_runs WHERE id = $1`, [id])).rows[0];
      return row ? this.toRecord(client, tenant, row) : null;
    });
  }

  active(tenant: TenantContext, conversationId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<RunRow>(`SELECT ${COLUMNS} FROM agent_runs WHERE conversation_id = $1 AND status IN ('running', 'waiting')`, [conversationId])
      ).rows[0];
      return row ? this.toRecord(client, tenant, row) : null;
    });
  }

  claim(tenant: TenantContext, id: string, owner: string, leaseMs: number) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (
        await client.query<RunRow>(
          `UPDATE agent_runs
           SET status = 'running', lease_owner = $2, lease_until = now() + make_interval(secs => $3), updated_at = now()
           WHERE id = $1 AND (status = 'waiting' OR lease_until IS NULL OR lease_until < now())
           RETURNING ${COLUMNS}`,
          [id, owner, leaseMs / 1000],
        )
      ).rows[0];
      return row ? this.toRecord(client, tenant, row) : null;
    });
  }

  renew(tenant: TenantContext, id: string, owner: string, leaseMs: number, progress?: RunProgress) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query<{ cancel_requested: boolean }>(
        `UPDATE agent_runs
         SET lease_until = now() + make_interval(secs => $3), updated_at = now(), progress = COALESCE($4, progress)
         WHERE id = $1 AND lease_owner = $2 AND status = 'running'
         RETURNING cancel_requested`,
        [id, owner, leaseMs / 1000, progress ? await this.seal(client, tenant, id, "progress", progress) : null],
      );
      const row = result.rows[0];
      return { held: Boolean(row), cancelRequested: row?.cancel_requested ?? false };
    });
  }

  pause(tenant: TenantContext, id: string, owner: string, progress: RunProgress) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query(
        `UPDATE agent_runs SET status = 'waiting', lease_owner = NULL, lease_until = NULL, progress = $3, updated_at = now()
         WHERE id = $1 AND lease_owner = $2`,
        [id, owner, await this.seal(client, tenant, id, "progress", progress)],
      );
    });
  }

  finish(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query("DELETE FROM agent_runs WHERE id = $1", [id]);
    });
  }

  requestCancel(tenant: TenantContext, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("UPDATE agent_runs SET cancel_requested = true WHERE id = $1", [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async stale(waitingTtlSeconds: number) {
    const result = await this.pool.query<{ run_id: string; organization_id: string; user_id: string; status: RunStatus }>(
      "SELECT run_id, organization_id, user_id, status FROM snowfall_stale_runs(make_interval(secs => $1))",
      [waitingTtlSeconds],
    );
    return result.rows.map((row) => ({ runId: row.run_id, organizationId: row.organization_id, userId: row.user_id, status: row.status }));
  }
}

// ---- Diffusion des événements aux connexions ouvertes ----------------------

export type RunEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "step"; step: ToolEvent }
  | { type: "approval"; approval: PendingApproval }
  | { type: "paused" }
  /** Avancement relu en base (run exécuté par une autre instance). */
  | { type: "snapshot"; progress: RunProgress }
  | { type: "done"; payload: unknown }
  | { type: "error"; error: string };

/**
 * Événements d'un run vers les flux SSE de cette instance. Un client qui se
 * reconnecte reçoit d'abord l'avancement enregistré, puis la suite en direct.
 */
export class RunEvents {
  private readonly listeners = new Map<string, Set<(event: RunEvent) => void>>();

  subscribe(runId: string, listener: (event: RunEvent) => void) {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(runId);
    };
  }

  emit(runId: string, event: RunEvent) {
    for (const listener of this.listeners.get(runId) ?? []) listener(event);
  }
}
