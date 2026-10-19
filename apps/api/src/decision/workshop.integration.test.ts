import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { MAX_EXAMPLES, PostgresWorkshopStore, type DecisionHead } from "./workshop.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Atelier d'entraînement : PostgreSQL (chiffrement, un seul actif, isolation)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresWorkshopStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const [admin, outsider] = [randomUUID(), randomUUID()];
  const head: DecisionHead = { revision: "7b928d828b7b", weights: new Array(768).fill(0.001), bias: 0.5, threshold: 0.5, labels: { positive: "complexe", negative: "simple" } };
  const metrics = (right: number) => ({ candidate: { tp: right, fn: 0, tn: 12, fp: 0 }, baseline: { tp: 10, fn: 2, tn: 12, fp: 0 }, baselineKind: "zero_shot" as const, baselineVersion: null, cv: 0.9, train: 40, test: 24 });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    store = new PostgresWorkshopStore(pool, new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32))));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    for (const id of [admin, outsider]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'admin')", [org, admin, other, outsider]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[admin, outsider]]);
    await pool.end();
    await owner.end();
  });

  async function within<T>(organizationId: string, sql: string, params: unknown[]) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      const result = await client.query<T & Record<string, unknown>>(sql, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const as = (userId: string, organizationId = org) => ({ userId, organizationId });

  it("exemples : chiffrés, part figée, plafond, invisibles ailleurs", async () => {
    const created = await store.addExamples(as(admin), "routing", [{ text: "Code client 4242 : analyse le contrat", label: "complexe" }, { text: "Bonjour", label: "simple" }]);
    assert.equal(created?.length, 2);
    assert.ok(created!.every((item) => item.split === "train" || item.split === "test"));
    const raw = await within(org, "SELECT text_enc, split FROM decision_examples WHERE organization_id = $1", [org]);
    assert.equal(raw.rows.length, 2);
    assert.ok(!JSON.stringify(raw.rows).includes("4242"));
    assert.deepEqual(await store.examples(as(outsider, other), "routing"), []);
    // Plafond : un lot qui le dépasserait est refusé en entier.
    assert.equal(await store.addExamples(as(admin), "routing", Array.from({ length: MAX_EXAMPLES }, () => ({ text: "x", label: "simple" }))), null);
    // La part d'un exemple ne se réécrit pas (aucun droit UPDATE).
    await assert.rejects(pool.query("UPDATE decision_examples SET split = 'train'"), /permission denied/);
  });

  it("modèles : tête chiffrée, figée ; un seul actif ; un non déployable ne s'active pas", async () => {
    const good = await store.addModel(as(admin), "routing", { head, metrics: metrics(12) });
    const bad = await store.addModel(as(admin), "routing", { head, metrics: metrics(9) });
    assert.deepEqual([good.version, good.deployable, bad.version, bad.deployable], [1, true, 2, false]);
    const raw = await within(org, "SELECT head_enc FROM decision_models WHERE organization_id = $1", [org]);
    assert.ok(!JSON.stringify(raw.rows).includes("0.001"));
    await assert.rejects(pool.query("UPDATE decision_models SET head_enc = head_enc"), /permission denied/);

    assert.equal(await store.activate(as(admin), "routing", bad.id), false);
    // Même en contournant l'application, la base refuse un actif non déployable.
    await assert.rejects(within(org, "UPDATE decision_models SET status = 'active' WHERE id = $1", [bad.id]), /decision_models_active_check/);
    assert.equal(await store.activate(as(admin), "routing", good.id), true);
    assert.deepEqual((await store.activeHead(as(admin), "routing"))?.head, head);

    const third = await store.addModel(as(admin), "routing", { head: { ...head, bias: 1 }, metrics: metrics(12) });
    assert.equal(await store.activate(as(admin), "routing", third.id), true);
    const statuses = (await store.models(as(admin), "routing")).map((model) => [model.version, model.status]);
    assert.deepEqual(statuses, [[3, "active"], [2, "candidate"], [1, "retired"]]);
    // Autre organisation : ni lecture, ni activation.
    assert.equal(await store.activeHead(as(outsider, other), "routing"), null);
    assert.equal(await store.activate(as(outsider, other), "routing", third.id), false);
    await store.deactivate(as(admin), "routing");
    assert.equal(await store.activeHead(as(admin), "routing"), null);
  });
});
