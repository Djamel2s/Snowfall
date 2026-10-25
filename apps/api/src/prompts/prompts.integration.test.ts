import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresSharingStore } from "../sharing/store.js";
import { PostgresPromptStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Prompts : PostgreSQL (RLS, chiffrement)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresPromptStore;
  let keyring: OrganizationKeyring;
  const org = randomUUID();
  const other = randomUUID();
  const [alice, bob, eve] = [randomUUID(), randomUUID(), randomUUID()];
  const a = { userId: alice, organizationId: org };
  const b = { userId: bob, organizationId: org };
  const e = { userId: eve, organizationId: other };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    store = new PostgresPromptStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $4), ($2, $5), ($3, $6)", [alice, bob, eve, `${alice}@t.local`, `${bob}@t.local`, `${eve}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'member'), ($1, $4, 'member'), ($2, $5, 'member')", [org, other, alice, bob, eve]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob, eve]]);
    await pool.end();
    await owner.end();
  });

  it("privé invisible, partagé (organisation) lisible, jamais modifiable sans droit, chiffré", async () => {
    const secret = await store.create(a, { name: "Négociation Orion", content: "Prix plancher : 4,2 M€" });
    const shared = await store.create(a, { name: "Compte rendu", content: "Résume {{réunion}}" });
    await new PostgresSharingStore(pool, keyring).setGrants(a, "prompt", shared.id, [{ principal: { type: "organization" }, permission: "view" }]);
    assert.deepEqual((await store.list(b)).map((prompt) => prompt.id), [shared.id]);
    assert.equal((await store.list(b))[0]!.canEdit, false);
    assert.equal((await store.list(a)).find((prompt) => prompt.id === shared.id)?.shared, true);
    assert.deepEqual(await store.list(e), []);
    assert.equal(await store.update(b, shared.id, { name: "x", content: "x" }), null);
    assert.equal(await store.delete(b, shared.id), false);
    // Même en SQL direct, la RLS empêche un collègue de modifier ou de lire le privé.
    const tampered = await withTenant(pool, b, (client) => client.query("UPDATE prompts SET name = name WHERE id = ANY($1)", [[secret.id, shared.id]]));
    assert.equal(tampered.rowCount, 0);
    const raw = await withTenant(owner, a, (client) => client.query("SELECT name, content FROM prompts WHERE id = $1", [secret.id]));
    assert.ok(!/orion|4,2/i.test(JSON.stringify(raw.rows)));
    await assert.rejects(withTenant(owner, a, (client) => client.query("UPDATE prompts SET content = 'clair' WHERE id = $1", [secret.id])), /prompts_encrypted_check/);
  });
});
