import { randomInt, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant, type TenantContext } from "../db/tenant.js";
import { ROUTING_COMPLEX_THRESHOLD, ROUTING_QUESTION } from "./routing.js";

// Atelier d'entraînement (administrateurs) : exemples étiquetés saisis à la main,
// têtes de décision entraînées localement, mesurées sur une part de test fixée
// à l'ajout de chaque exemple, déployées seulement si elles battent la référence.

/** Tâches entraînables : étiquettes, et décideur de base (Laya sans entraînement). */
export const DECISION_TASKS = {
  routing: { labels: { positive: "complexe", negative: "simple" }, question: ROUTING_QUESTION, threshold: ROUTING_COMPLEX_THRESHOLD },
} as const;
export type DecisionTask = keyof typeof DECISION_TASKS;

export const MAX_EXAMPLES = 600;
/** Part de test : environ 30 %, tirée une fois pour toutes à l'ajout. */
const TEST_SHARE = 3;

export type DecisionHead = { revision: string; weights: number[]; bias: number; threshold: number; labels: { positive: string; negative: string } };
export type Confusion = { tp: number; fn: number; tn: number; fp: number };
export type DecisionMetrics = { candidate: Confusion; baseline: Confusion; baselineKind: "zero_shot" | "head"; baselineVersion: number | null; cv: number; train: number; test: number };

export type DecisionExample = { id: string; text: string; label: string; split: "train" | "test"; createdAt: string };
export type DecisionModel = { id: string; version: number; status: "candidate" | "active" | "retired"; deployable: boolean; metrics: DecisionMetrics; createdAt: string; activatedAt: string | null };

/**
 * Règle de déploiement : plus de bonnes décisions que la référence sur la part de
 * test, ET au moins autant de questions complexes reconnues (rater une question
 * complexe donne une mauvaise réponse ; l'inverse coûte seulement plus cher).
 */
export function deployable(metrics: Pick<DecisionMetrics, "candidate" | "baseline">) {
  const right = (c: Confusion) => c.tp + c.tn;
  const recall = (c: Confusion) => (c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0);
  return right(metrics.candidate) > right(metrics.baseline) && recall(metrics.candidate) >= recall(metrics.baseline);
}

export interface WorkshopStore {
  examples(tenant: TenantContext, task: DecisionTask): Promise<DecisionExample[]>;
  /** null : plafond atteint. */
  addExamples(tenant: TenantContext, task: DecisionTask, items: { text: string; label: string }[]): Promise<DecisionExample[] | null>;
  deleteExample(tenant: TenantContext, task: DecisionTask, id: string): Promise<boolean>;
  models(tenant: TenantContext, task: DecisionTask): Promise<DecisionModel[]>;
  addModel(tenant: TenantContext, task: DecisionTask, input: { head: DecisionHead; metrics: DecisionMetrics }): Promise<DecisionModel>;
  head(tenant: TenantContext, task: DecisionTask, id: string): Promise<DecisionHead | null>;
  /** Tête active (null : décideur de base). */
  activeHead(tenant: TenantContext, task: DecisionTask): Promise<{ version: number; head: DecisionHead } | null>;
  /** Active un modèle déployable (l'ancien actif est retiré) ; false s'il ne l'est pas. */
  activate(tenant: TenantContext, task: DecisionTask, id: string): Promise<boolean>;
  /** Retour au décideur de base. */
  deactivate(tenant: TenantContext, task: DecisionTask): Promise<void>;
}

export const exampleAad = (organizationId: string, id: string) => `decision-example:${organizationId}:${id}`;
export const headAad = (organizationId: string, id: string) => `decision-head:${organizationId}:${id}`;

const splitFor = (): "train" | "test" => (randomInt(10) < TEST_SHARE ? "test" : "train");

type ExampleRow = { id: string; text_enc: string; label: string; split: "train" | "test"; createdAt: string };
type ModelRow = { id: string; version: number; status: DecisionModel["status"]; deployable: boolean; metrics: DecisionMetrics; createdAt: string; activatedAt: string | null };
const MODEL_COLUMNS = `id, version, status, deployable, metrics, created_at AS "createdAt", activated_at AS "activatedAt"`;

export class PostgresWorkshopStore implements WorkshopStore {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: OrganizationKeyring,
  ) {}

  private async toExample(client: PoolClient, tenant: TenantContext, row: ExampleRow): Promise<DecisionExample> {
    return { id: row.id, text: await this.keyring.decrypt(client, tenant.organizationId, row.text_enc, exampleAad(tenant.organizationId, row.id)), label: row.label, split: row.split, createdAt: row.createdAt };
  }

  examples(tenant: TenantContext, task: DecisionTask) {
    return withTenant(this.pool, tenant, async (client) => {
      const rows = (await client.query<ExampleRow>(`SELECT id, text_enc, label, split, created_at AS "createdAt" FROM decision_examples WHERE organization_id = $1 AND task = $2 ORDER BY created_at DESC LIMIT ${MAX_EXAMPLES}`, [tenant.organizationId, task])).rows;
      const examples: DecisionExample[] = [];
      for (const row of rows) examples.push(await this.toExample(client, tenant, row));
      return examples;
    });
  }

  addExamples(tenant: TenantContext, task: DecisionTask, items: { text: string; label: string }[]) {
    return withTenant(this.pool, tenant, async (client) => {
      // Plafond sous verrou de l'organisation : pas de dépassement par requêtes concurrentes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`decision-examples:${tenant.organizationId}:${task}`]);
      const count = Number((await client.query<{ count: string }>("SELECT count(*) FROM decision_examples WHERE organization_id = $1 AND task = $2", [tenant.organizationId, task])).rows[0]!.count);
      if (count + items.length > MAX_EXAMPLES) return null;
      const created: DecisionExample[] = [];
      for (const item of items) {
        const id = randomUUID();
        const sealed = await this.keyring.encrypt(client, tenant.organizationId, item.text, exampleAad(tenant.organizationId, id));
        const row = (
          await client.query<ExampleRow>(
            `INSERT INTO decision_examples (id, organization_id, task, text_enc, label, split, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, text_enc, label, split, created_at AS "createdAt"`,
            [id, tenant.organizationId, task, sealed, item.label, splitFor(), tenant.userId || null],
          )
        ).rows[0]!;
        created.push({ id: row.id, text: item.text, label: row.label, split: row.split, createdAt: row.createdAt });
      }
      return created;
    });
  }

  deleteExample(tenant: TenantContext, task: DecisionTask, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query("DELETE FROM decision_examples WHERE id = $1 AND organization_id = $2 AND task = $3", [id, tenant.organizationId, task]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  models(tenant: TenantContext, task: DecisionTask) {
    return withTenant(this.pool, tenant, async (client) =>
      (await client.query<ModelRow>(`SELECT ${MODEL_COLUMNS} FROM decision_models WHERE organization_id = $1 AND task = $2 ORDER BY version DESC LIMIT 20`, [tenant.organizationId, task])).rows,
    );
  }

  addModel(tenant: TenantContext, task: DecisionTask, input: { head: DecisionHead; metrics: DecisionMetrics }) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`decision-models:${tenant.organizationId}:${task}`]);
      const version = Number((await client.query<{ next: string }>("SELECT coalesce(max(version), 0) + 1 AS next FROM decision_models WHERE organization_id = $1 AND task = $2", [tenant.organizationId, task])).rows[0]!.next);
      const id = randomUUID();
      const sealed = await this.keyring.encrypt(client, tenant.organizationId, JSON.stringify(input.head), headAad(tenant.organizationId, id));
      return (
        await client.query<ModelRow>(
          `INSERT INTO decision_models (id, organization_id, task, version, head_enc, metrics, deployable, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'candidate', $8) RETURNING ${MODEL_COLUMNS}`,
          [id, tenant.organizationId, task, version, sealed, JSON.stringify(input.metrics), deployable(input.metrics), tenant.userId || null],
        )
      ).rows[0]!;
    });
  }

  head(tenant: TenantContext, task: DecisionTask, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<{ id: string; head_enc: string }>("SELECT id, head_enc FROM decision_models WHERE id = $1 AND organization_id = $2 AND task = $3", [id, tenant.organizationId, task])).rows[0];
      return row ? (JSON.parse(await this.keyring.decrypt(client, tenant.organizationId, row.head_enc, headAad(tenant.organizationId, row.id))) as DecisionHead) : null;
    });
  }

  activeHead(tenant: TenantContext, task: DecisionTask) {
    return withTenant(this.pool, tenant, async (client) => {
      const row = (await client.query<{ id: string; version: number; head_enc: string }>("SELECT id, version, head_enc FROM decision_models WHERE organization_id = $1 AND task = $2 AND status = 'active'", [tenant.organizationId, task])).rows[0];
      return row ? { version: row.version, head: JSON.parse(await this.keyring.decrypt(client, tenant.organizationId, row.head_enc, headAad(tenant.organizationId, row.id))) as DecisionHead } : null;
    });
  }

  activate(tenant: TenantContext, task: DecisionTask, id: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const target = (await client.query<{ deployable: boolean }>("SELECT deployable FROM decision_models WHERE id = $1 AND organization_id = $2 AND task = $3 FOR UPDATE", [id, tenant.organizationId, task])).rows[0];
      if (!target?.deployable) return false;
      await client.query("UPDATE decision_models SET status = 'retired' WHERE organization_id = $1 AND task = $2 AND status = 'active'", [tenant.organizationId, task]);
      await client.query("UPDATE decision_models SET status = 'active', activated_at = now() WHERE id = $1", [id]);
      return true;
    });
  }

  deactivate(tenant: TenantContext, task: DecisionTask) {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query("UPDATE decision_models SET status = 'retired' WHERE organization_id = $1 AND task = $2 AND status = 'active'", [tenant.organizationId, task]);
    });
  }
}

/** Développement et tests : mêmes règles, sans chiffrement. */
export class MemoryWorkshopStore implements WorkshopStore {
  private readonly exampleRows: (DecisionExample & { organizationId: string; task: DecisionTask })[] = [];
  private readonly modelRows: (DecisionModel & { organizationId: string; task: DecisionTask; head: DecisionHead })[] = [];
  /** Tests : part imposée (sinon tirée comme en production). */
  constructor(private readonly split: (index: number) => "train" | "test" = () => splitFor()) {}

  private mine<T extends { organizationId: string; task: DecisionTask }>(rows: T[], tenant: TenantContext, task: DecisionTask) {
    return rows.filter((row) => row.organizationId === tenant.organizationId && row.task === task);
  }

  async examples(tenant: TenantContext, task: DecisionTask) {
    return this.mine(this.exampleRows, tenant, task).reverse().map(({ organizationId: _o, task: _t, ...row }) => ({ ...row }));
  }

  async addExamples(tenant: TenantContext, task: DecisionTask, items: { text: string; label: string }[]) {
    const count = this.mine(this.exampleRows, tenant, task).length;
    if (count + items.length > MAX_EXAMPLES) return null;
    const created = items.map((item, index) => ({ id: randomUUID(), text: item.text, label: item.label, split: this.split(count + index), createdAt: new Date().toISOString() }));
    this.exampleRows.push(...created.map((row) => ({ ...row, organizationId: tenant.organizationId, task })));
    return created;
  }

  async deleteExample(tenant: TenantContext, task: DecisionTask, id: string) {
    const index = this.exampleRows.findIndex((row) => row.id === id && row.organizationId === tenant.organizationId && row.task === task);
    if (index === -1) return false;
    this.exampleRows.splice(index, 1);
    return true;
  }

  async models(tenant: TenantContext, task: DecisionTask) {
    return this.mine(this.modelRows, tenant, task).reverse().map(({ organizationId: _o, task: _t, head: _h, ...row }) => structuredClone(row));
  }

  async addModel(tenant: TenantContext, task: DecisionTask, input: { head: DecisionHead; metrics: DecisionMetrics }) {
    const row = { id: randomUUID(), version: this.mine(this.modelRows, tenant, task).length + 1, status: "candidate" as const, deployable: deployable(input.metrics), metrics: input.metrics, createdAt: new Date().toISOString(), activatedAt: null, organizationId: tenant.organizationId, task, head: input.head };
    this.modelRows.push(row);
    const { organizationId: _o, task: _t, head: _h, ...view } = row;
    return structuredClone(view);
  }

  async head(tenant: TenantContext, task: DecisionTask, id: string) {
    return this.mine(this.modelRows, tenant, task).find((row) => row.id === id)?.head ?? null;
  }

  async activeHead(tenant: TenantContext, task: DecisionTask) {
    const row = this.mine(this.modelRows, tenant, task).find((item) => item.status === "active");
    return row ? { version: row.version, head: row.head } : null;
  }

  async activate(tenant: TenantContext, task: DecisionTask, id: string) {
    const rows = this.mine(this.modelRows, tenant, task);
    const target = rows.find((row) => row.id === id);
    if (!target?.deployable) return false;
    for (const row of rows) if (row.status === "active") row.status = "retired";
    target.status = "active";
    target.activatedAt = new Date().toISOString();
    return true;
  }

  async deactivate(tenant: TenantContext, task: DecisionTask) {
    for (const row of this.mine(this.modelRows, tenant, task)) if (row.status === "active") row.status = "retired";
  }
}
