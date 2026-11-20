import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresModelKeyStore } from "./keys.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Clés d'API des fournisseurs : PostgreSQL", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let keys: PostgresModelKeyStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const [alice, bob, eve] = [randomUUID(), randomUUID(), randomUUID()];
  const a = { userId: alice, organizationId: org };
  const b = { userId: bob, organizationId: org };
  const e = { userId: eve, organizationId: other };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    keys = new PostgresModelKeyStore(pool, new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32))));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    for (const id of [alice, bob, eve]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'admin'), ($1, $4, 'member'), ($2, $5, 'admin')", [org, other, alice, bob, eve]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob, eve]]);
    await pool.end();
    await owner.end();
  });

  it("clé de l'organisation : servie à ses membres, jamais à une autre organisation ; chiffrée en base", async () => {
    await keys.set(a, "organization", "mistral", "sk-organisation-AAAA-1111");
    assert.equal((await keys.secrets(b)).organization.mistral, "sk-organisation-AAAA-1111");
    assert.deepEqual((await keys.secrets(e)).organization, {});
    assert.deepEqual((await keys.list(b)).organization.map((key) => [key.provider, key.hint]), [["mistral", "1111"]]);
    const raw = await owner.query("SELECT api_key FROM organization_model_keys WHERE organization_id = $1", [org]);
    assert.ok(!JSON.stringify(raw.rows).includes("sk-organisation"));
    // Une autre organisation ne peut ni lire ni écraser (RLS).
    const peek = await withTenant(pool, e, (client) => client.query("SELECT 1 FROM organization_model_keys WHERE organization_id = $1", [org]));
    assert.equal(peek.rowCount, 0);
    await assert.rejects(
      withTenant(pool, e, (client) => client.query("INSERT INTO organization_model_keys (organization_id, provider, api_key, hint) VALUES ($1, 'openai', '1:v1.AAAA.BBBB', 'x')", [org])),
      /row-level security/,
    );
  });

  it("clé personnelle : lisible par son seul propriétaire (pas même un administrateur), chiffrée, refusée en clair", async () => {
    await keys.set(b, "personal", "openai", "sk-personnelle-BBBB-2222");
    assert.equal((await keys.secrets(b)).personal.openai, "sk-personnelle-BBBB-2222");
    assert.deepEqual((await keys.secrets(a)).personal, {});
    assert.deepEqual((await keys.list(a)).personal, []);
    const peek = await withTenant(pool, a, (client) => client.query("SELECT 1 FROM user_model_keys WHERE user_id = $1", [bob]));
    assert.equal(peek.rowCount, 0);
    await assert.rejects(
      withTenant(owner, b, (client) => client.query("UPDATE user_model_keys SET api_key = 'sk-en-clair' WHERE user_id = $1", [bob])),
      /user_model_keys_encrypted_check/,
    );
    await assert.rejects(
      withTenant(owner, b, (client) => client.query("UPDATE user_model_keys SET hint = 'trop-long' WHERE user_id = $1", [bob])),
      /user_model_keys_hint_check/,
    );
    // Remplacer : une seule clé par fournisseur ; retirer : effacée.
    await keys.set(b, "personal", "openai", "sk-personnelle-CCCC-3333");
    assert.deepEqual((await keys.list(b)).personal.map((key) => key.hint), ["3333"]);
    assert.equal(await keys.remove(b, "personal", "openai"), true);
    assert.equal(await keys.remove(b, "personal", "openai"), false);
  });

  it("départ d'un membre : ses clés personnelles sont effacées avec lui", async () => {
    await keys.set(b, "personal", "anthropic", "sk-depart-DDDD-4444");
    await owner.query("DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", [org, bob]);
    const left = await owner.query("SELECT 1 FROM user_model_keys WHERE user_id = $1", [bob]);
    assert.equal(left.rowCount, 0);
  });
});
