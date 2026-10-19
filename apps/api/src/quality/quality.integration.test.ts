import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresAgentStore } from "../agents/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { PostgresQualityStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Qualité des agents : PostgreSQL (chiffrement, isolation, cascade)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let agents: PostgresAgentStore;
  let quality: PostgresQualityStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const [author, member, outsider] = [randomUUID(), randomUUID(), randomUUID()];
  const avatar = { kind: "alien" as const, color: "mint" as const, eyes: "sleepy" as const, accessory: "none" as const };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    agents = new PostgresAgentStore(pool, keyring);
    quality = new PostgresQualityStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    for (const id of [author, member, outsider]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
    for (const id of [author, member]) await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, id]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [other, outsider]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[author, member, outsider]]);
    await pool.end();
    await owner.end();
  });

  const as = (userId: string, organizationId = org) => ({ userId, organizationId });

  /** Requête du propriétaire DANS une organisation : la RLS est imposée même à lui. */
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

  it("versions : numérotées, sans doublon d'instructions identiques, chiffrées, invisibles ailleurs", async () => {
    const agent = await agents.create(as(author), { name: "Accueil", avatar, instructions: "Réponds.", provider: "mistral", model: "mistral-small-latest" });
    const first = await quality.addVersion(as(author), agent.id, { instructions: "Réponds avec le code 4242.", source: "edit" });
    assert.equal(first?.version, 1);
    assert.equal(await quality.addVersion(as(author), agent.id, { instructions: "Réponds avec le code 4242.", source: "edit" }), null);
    const second = await quality.addVersion(as(author), agent.id, { instructions: "Sois poli.", source: "improvement", score: { passed: 3, total: 3, mean: 5 } });
    assert.equal(second?.version, 2);
    await quality.setScore(as(author), agent.id, first!.id, { passed: 1, total: 3, mean: 2 });
    assert.deepEqual((await quality.versions(as(member), agent.id)).map((item) => [item.version, item.score?.passed]), [[2, 3], [1, 1]]);

    // Au repos : chiffré.
    const raw = await within(org, "SELECT instructions_enc FROM agent_versions WHERE agent_id = $1", [agent.id]);
    assert.equal(raw.rows.length, 2);
    assert.ok(!JSON.stringify(raw.rows).includes("4242"));
    // Le rôle applicatif ne réécrit pas une version (seul le score change).
    await assert.rejects(pool.query("UPDATE agent_versions SET instructions_enc = instructions_enc"), /permission denied/);
    // Autre organisation : rien, ni en lecture ni en écriture.
    assert.deepEqual(await quality.versions(as(outsider, other), agent.id), []);
    assert.equal(await quality.version(as(outsider, other), agent.id, first!.id), null);
    await assert.rejects(quality.addVersion(as(outsider, other), agent.id, { instructions: "Pirate.", source: "edit" }));
  });

  it("cas : un par réponse notée, retirés par leur seul auteur, effacés avec l'agent", async () => {
    const agent = await agents.create(as(author), { name: "Support", avatar, instructions: "", provider: "mistral", model: "mistral-small-latest" });
    const message = randomUUID();
    const shared = await quality.addCase(as(member), agent.id, { origin: "feedback", question: "Mon salaire est-il versé le 28 ?", comment: "Faux.", sourceMessageId: message });
    assert.equal(shared?.status, "proposed");
    assert.equal(await quality.addCase(as(member), agent.id, { origin: "feedback", question: "Encore", sourceMessageId: message }), null);
    const raw = await within(org, "SELECT question_enc, comment_enc FROM agent_eval_cases WHERE agent_id = $1", [agent.id]);
    assert.equal(raw.rows.length, 1);
    assert.ok(!JSON.stringify(raw.rows).includes("salaire"));

    // Un cas actif a toujours un critère (contrainte en base).
    await assert.rejects(within(org, "UPDATE agent_eval_cases SET status = 'active' WHERE agent_id = $1", [agent.id]), /agent_eval_cases_rubric_check/);
    const active = await quality.activateCase(as(author), agent.id, shared!.id, "Donne la date exacte du versement.");
    assert.equal(active?.rubric, "Donne la date exacte du versement.");

    // Retrait : l'auteur de l'agent ne retire pas le cas d'un autre ; son auteur, si.
    await quality.withdrawShared(as(author), message);
    assert.equal((await quality.cases(as(author), agent.id)).length, 1);
    await quality.withdrawShared(as(member), message);
    assert.equal((await quality.cases(as(author), agent.id)).length, 0);

    await quality.addCase(as(author), agent.id, { origin: "manual", question: "Bonjour ?", rubric: "Poli." });
    await quality.addVersion(as(author), agent.id, { instructions: "Sois poli.", source: "edit" });
    await agents.delete(as(author), agent.id);
    const left = await within(org, "SELECT (SELECT count(*) FROM agent_eval_cases WHERE agent_id = $1) AS cases, (SELECT count(*) FROM agent_versions WHERE agent_id = $1) AS versions", [agent.id]);
    assert.deepEqual(left.rows[0], { cases: "0", versions: "0" });
  });

  it("un cas ou une version ne peut pas viser l'agent d'une autre organisation", async () => {
    const agent = await agents.create(as(author), { name: "Juriste", avatar, instructions: "", provider: "mistral", model: "mistral-small-latest" });
    await assert.rejects(
      within(other, "INSERT INTO agent_eval_cases (organization_id, agent_id, status, origin, question_enc) VALUES ($1, $2, 'proposed', 'manual', '1:v1.a.b')", [other, agent.id]),
      /agent_eval_cases_agent_org_fk/,
    );
    await assert.rejects(
      within(org, "INSERT INTO agent_versions (organization_id, agent_id, version, instructions_enc, source) VALUES ($1, $2, 1, 'en clair', 'edit')", [org, agent.id]),
      /agent_versions_encrypted_check/,
    );
  });
});
