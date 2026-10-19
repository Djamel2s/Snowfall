import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";

// Qualité des agents : versions des instructions (avec leur score) et cas
// d'évaluation. Contenus chiffrés par organisation, AAD liée à la ligne.

export type VersionSource = "edit" | "improvement" | "restore";
/** Score mesuré sur les cas actifs : aucun contenu. */
export type QualityScore = { passed: number; total: number; mean: number };

export type AgentVersion = {
  id: string;
  version: number;
  instructions: string;
  source: VersionSource;
  score: QualityScore | null;
  createdAt: string;
};

export type EvalCaseStatus = "proposed" | "active";

export type AgentEvalCase = {
  id: string;
  status: EvalCaseStatus;
  origin: "feedback" | "manual";
  question: string;
  comment: string | null;
  rubric: string | null;
  createdAt: string;
};

/** Bornes : de quoi mesurer sans transformer une amélioration en facture. */
export const MAX_CASES_PER_AGENT = 30;
export const MAX_VERSIONS_LISTED = 20;

export interface QualityStore {
  versions(tenant: TenantContext, agentId: string): Promise<AgentVersion[]>;
  version(tenant: TenantContext, agentId: string, id: string): Promise<AgentVersion | null>;
  /** Nouvelle version (numéro suivant) ; rien si les instructions n'ont pas changé. */
  addVersion(tenant: TenantContext, agentId: string, input: { instructions: string; source: VersionSource; score?: QualityScore | null }): Promise<AgentVersion | null>;
  setScore(tenant: TenantContext, agentId: string, id: string, score: QualityScore): Promise<void>;
  cases(tenant: TenantContext, agentId: string): Promise<AgentEvalCase[]>;
  /** null : plafond atteint ou réponse déjà proposée. */
  addCase(tenant: TenantContext, agentId: string, input: { origin: "feedback" | "manual"; question: string; comment?: string | null; rubric?: string | null; sourceMessageId?: string }): Promise<AgentEvalCase | null>;
  activateCase(tenant: TenantContext, agentId: string, id: string, rubric: string): Promise<AgentEvalCase | null>;
  deleteCase(tenant: TenantContext, agentId: string, id: string): Promise<boolean>;
  /** Retrait du 👎 par son auteur : le cas qui en venait disparaît. */
  withdrawShared(tenant: TenantContext, sourceMessageId: string): Promise<void>;
}

export const versionAad = (organizationId: string, id: string) => `agent-version:${organizationId}:${id}`;
export const caseAad = (organizationId: string, id: string, field: "question" | "comment" | "rubric") => `agent-eval-case:${organizationId}:${id}:${field}`;

type VersionRow = { id: string; version: number; instructions_enc: string; source: VersionSource; score: QualityScore | null; createdAt: string };
type CaseRow = { id: string; status: EvalCaseStatus; origin: "feedback" | "manual"; question_enc: string; comment_enc: string | null; rubric_enc: string | null; createdAt: string };

const VERSION_COLUMNS = `id, version, instructions_enc, source, score, created_at AS "createdAt"`;
const CASE_COLUMNS = `id, status, origin, question_enc, comment_enc, rubric_enc, created_at AS "createdAt"`;

export class PostgresQualityStore implements QualityStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async toVersion(client: PoolClient, tenant: TenantContext, row: VersionRow): Promise<AgentVersion> {
    return {
      id: row.id,
      version: row.version,
      instructions: await this.keyring.decrypt(client, tenant.organizationId, row.instructions_enc, versionAad(tenant.organizationId, row.id)),
      source: row.source,
      score: row.score,
      createdAt: row.createdAt,
    };
  }

  private async toCase(client: PoolClient, tenant: TenantContext, row: CaseRow): Promise<AgentEvalCase> {
    const open = (value: string | null, field: "question" | "comment" | "rubric") =>
      value === null ? Promise.resolve(null) : this.keyring.decrypt(client, tenant.organizationId, value, caseAad(tenant.organizationId, row.id, field));
    return {
      id: row.id,
      status: row.status,
      origin: row.origin,
      question: (await open(row.question_enc, "question"))!,
      comment: await open(row.comment_enc, "comment"),
      rubric: await open(row.rubric_enc, "rubric"),
      createdAt: row.createdAt,
    };
  }

  versions(tenant: TenantContext, agentId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (await client.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM agent_versions WHERE agent_id = $1 AND organization_id = $2 ORDER BY version DESC LIMIT ${MAX_VERSIONS_LISTED}`, [agentId, tenant.organizationId])).rows;
      const versions: AgentVersion[] = [];
      for (const row of rows) versions.push(await this.toVersion(client, tenant, row));
      return versions;
    });
  }

  version(tenant: TenantContext, agentId: string, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM agent_versions WHERE id = $1 AND agent_id = $2 AND organization_id = $3`, [id, agentId, tenant.organizationId])).rows[0];
      return row ? this.toVersion(client, tenant, row) : null;
    });
  }

  addVersion(tenant: TenantContext, agentId: string, input: { instructions: string; source: VersionSource; score?: QualityScore | null }) {
    return withTenant(this.pool, tenant, async (client) => {
      // Numérotation sans trou ni doublon même sous concurrence : verrou de l'agent.
      await client.query("SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2 FOR UPDATE", [agentId, tenant.organizationId]);
      const last = (await client.query<VersionRow>(`SELECT ${VERSION_COLUMNS} FROM agent_versions WHERE agent_id = $1 AND organization_id = $2 ORDER BY version DESC LIMIT 1`, [agentId, tenant.organizationId])).rows[0];
      if (last && (await this.toVersion(client, tenant, last)).instructions === input.instructions) return null;
      const id = randomUUID();
      const sealed = await this.keyring.encrypt(client, tenant.organizationId, input.instructions, versionAad(tenant.organizationId, id));
      const row = (
        await client.query<VersionRow>(
          `INSERT INTO agent_versions (id, organization_id, agent_id, version, instructions_enc, source, score, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${VERSION_COLUMNS}`,
          [id, tenant.organizationId, agentId, (last?.version ?? 0) + 1, sealed, input.source, input.score ? JSON.stringify(input.score) : null, tenant.userId || null],
        )
      ).rows[0]!;
      return this.toVersion(client, tenant, row);
    });
  }

  setScore(tenant: TenantContext, agentId: string, id: string, score: QualityScore) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query("UPDATE agent_versions SET score = $4 WHERE id = $1 AND agent_id = $2 AND organization_id = $3", [id, agentId, tenant.organizationId, JSON.stringify(score)]);
    });
  }

  cases(tenant: TenantContext, agentId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (await client.query<CaseRow>(`SELECT ${CASE_COLUMNS} FROM agent_eval_cases WHERE agent_id = $1 AND organization_id = $2 ORDER BY created_at DESC LIMIT ${MAX_CASES_PER_AGENT}`, [agentId, tenant.organizationId])).rows;
      const cases: AgentEvalCase[] = [];
      for (const row of rows) cases.push(await this.toCase(client, tenant, row));
      return cases;
    });
  }

  addCase(tenant: TenantContext, agentId: string, input: { origin: "feedback" | "manual"; question: string; comment?: string | null; rubric?: string | null; sourceMessageId?: string }) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query("SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2 FOR UPDATE", [agentId, tenant.organizationId]);
      const count = Number((await client.query<{ count: string }>("SELECT count(*) FROM agent_eval_cases WHERE agent_id = $1 AND organization_id = $2", [agentId, tenant.organizationId])).rows[0]!.count);
      if (count >= MAX_CASES_PER_AGENT) return null;
      const id = randomUUID();
      const seal = (value: string | null | undefined, field: "question" | "comment" | "rubric") =>
        value ? this.keyring.encrypt(client, tenant.organizationId, value, caseAad(tenant.organizationId, id, field)) : Promise.resolve(null);
      const row = (
        await client.query<CaseRow>(
          `INSERT INTO agent_eval_cases (id, organization_id, agent_id, status, origin, source_message_id, question_enc, comment_enc, rubric_enc, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (agent_id, source_message_id) DO NOTHING
           RETURNING ${CASE_COLUMNS}`,
          [id, tenant.organizationId, agentId, input.rubric ? "active" : "proposed", input.origin, input.sourceMessageId ?? null, await seal(input.question, "question"), await seal(input.comment, "comment"), await seal(input.rubric, "rubric"), tenant.userId || null],
        )
      ).rows[0];
      return row ? this.toCase(client, tenant, row) : null;
    });
  }

  activateCase(tenant: TenantContext, agentId: string, id: string, rubric: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const sealed = await this.keyring.encrypt(client, tenant.organizationId, rubric, caseAad(tenant.organizationId, id, "rubric"));
      const row = (
        await client.query<CaseRow>(
          `UPDATE agent_eval_cases SET status = 'active', rubric_enc = $4, updated_at = now()
           WHERE id = $1 AND agent_id = $2 AND organization_id = $3 RETURNING ${CASE_COLUMNS}`,
          [id, agentId, tenant.organizationId, sealed],
        )
      ).rows[0];
      return row ? this.toCase(client, tenant, row) : null;
    });
  }

  deleteCase(tenant: TenantContext, agentId: string, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM agent_eval_cases WHERE id = $1 AND agent_id = $2 AND organization_id = $3", [id, agentId, tenant.organizationId]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  withdrawShared(tenant: TenantContext, sourceMessageId: string) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query("DELETE FROM agent_eval_cases WHERE source_message_id = $1 AND organization_id = $2 AND created_by = $3 AND origin = 'feedback'", [sourceMessageId, tenant.organizationId, tenant.userId]);
    });
  }
}

/** Développement et tests : mêmes règles, sans chiffrement. */
export class MemoryQualityStore implements QualityStore {
  private readonly versionRows = new Map<string, (AgentVersion & { organizationId: string; agentId: string })[]>();
  private readonly caseRows: (AgentEvalCase & { organizationId: string; agentId: string; sourceMessageId?: string | undefined; createdBy: string })[] = [];

  private key = (tenant: TenantContext, agentId: string) => `${tenant.organizationId}:${agentId}`;
  private strip = <T extends { organizationId: string; agentId: string }>({ organizationId: _org, agentId: _agent, ...rest }: T) => structuredClone(rest);

  async versions(tenant: TenantContext, agentId: string) {
    return [...(this.versionRows.get(this.key(tenant, agentId)) ?? [])].reverse().slice(0, MAX_VERSIONS_LISTED).map(this.strip);
  }

  async version(tenant: TenantContext, agentId: string, id: string) {
    const row = this.versionRows.get(this.key(tenant, agentId))?.find((item) => item.id === id);
    return row ? this.strip(row) : null;
  }

  async addVersion(tenant: TenantContext, agentId: string, input: { instructions: string; source: VersionSource; score?: QualityScore | null }) {
    const list = this.versionRows.get(this.key(tenant, agentId)) ?? [];
    if (list.at(-1)?.instructions === input.instructions) return null;
    const row = { id: randomUUID(), version: list.length + 1, instructions: input.instructions, source: input.source, score: input.score ?? null, createdAt: new Date().toISOString(), organizationId: tenant.organizationId, agentId };
    this.versionRows.set(this.key(tenant, agentId), [...list, row]);
    return this.strip(row);
  }

  async setScore(tenant: TenantContext, agentId: string, id: string, score: QualityScore) {
    const row = this.versionRows.get(this.key(tenant, agentId))?.find((item) => item.id === id);
    if (row) row.score = score;
  }

  private mine(tenant: TenantContext, agentId: string) {
    return this.caseRows.filter((row) => row.organizationId === tenant.organizationId && row.agentId === agentId);
  }

  async cases(tenant: TenantContext, agentId: string) {
    return this.mine(tenant, agentId).reverse().map(({ sourceMessageId: _source, createdBy: _by, ...row }) => this.strip(row));
  }

  async addCase(tenant: TenantContext, agentId: string, input: { origin: "feedback" | "manual"; question: string; comment?: string | null; rubric?: string | null; sourceMessageId?: string }) {
    const mine = this.mine(tenant, agentId);
    if (mine.length >= MAX_CASES_PER_AGENT || (input.sourceMessageId && mine.some((row) => row.sourceMessageId === input.sourceMessageId))) return null;
    const row = {
      id: randomUUID(),
      status: (input.rubric ? "active" : "proposed") as EvalCaseStatus,
      origin: input.origin,
      question: input.question,
      comment: input.comment ?? null,
      rubric: input.rubric ?? null,
      createdAt: new Date().toISOString(),
      organizationId: tenant.organizationId,
      agentId,
      sourceMessageId: input.sourceMessageId,
      createdBy: tenant.userId,
    };
    this.caseRows.push(row);
    const { sourceMessageId: _source, createdBy: _by, ...view } = row;
    return this.strip(view);
  }

  async activateCase(tenant: TenantContext, agentId: string, id: string, rubric: string) {
    const row = this.mine(tenant, agentId).find((item) => item.id === id);
    if (!row) return null;
    row.status = "active";
    row.rubric = rubric;
    const { sourceMessageId: _source, createdBy: _by, ...view } = row;
    return this.strip(view);
  }

  async deleteCase(tenant: TenantContext, agentId: string, id: string) {
    const index = this.caseRows.findIndex((row) => row.organizationId === tenant.organizationId && row.agentId === agentId && row.id === id);
    if (index === -1) return false;
    this.caseRows.splice(index, 1);
    return true;
  }

  async withdrawShared(tenant: TenantContext, sourceMessageId: string) {
    for (let index = this.caseRows.length - 1; index >= 0; index--) {
      const row = this.caseRows[index]!;
      if (row.organizationId === tenant.organizationId && row.sourceMessageId === sourceMessageId && row.createdBy === tenant.userId && row.origin === "feedback") this.caseRows.splice(index, 1);
    }
  }
}
