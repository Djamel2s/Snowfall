import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresConversationStore } from "./store.js";

const url = process.env.TEST_DATABASE_URL;

describe("PostgresConversationStore : isolation des tenants", { skip: !url }, () => {
  let pool: Pool;
  let store: PostgresConversationStore;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const a = { userId: alice, organizationId: orgA };
  const b = { userId: bob, organizationId: orgB };

  before(async () => {
    pool = new Pool({ connectionString: url });
    store = new PostgresConversationStore(pool);
    await pool.query(
      "INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')",
      [orgA, orgB],
    );
    await pool.query(
      "INSERT INTO users (id, email) VALUES ($1, $3), ($2, $4)",
      [alice, bob, `${alice}@test.local`, `${bob}@test.local`],
    );
    await pool.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $3, 'member'), ($2, $4, 'member')`,
      [orgA, orgB, alice, bob],
    );
  });

  after(async () => {
    await pool.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
    await pool.end();
  });

  it("n'expose rien d'un autre tenant", async () => {
    const conv = await store.create(a, "Secret A");
    assert.equal((await store.list(b)).some((c) => c.id === conv.id), false);
    assert.equal(await store.getMessages(b, conv.id), null);
    assert.equal(await store.appendExchange(b, conv.id, "x", "y"), null);
    assert.equal(await store.delete(b, conv.id), false);
  });

  it("refuse de créer une conversation sans appartenance", async () => {
    await assert.rejects(
      store.create({ userId: alice, organizationId: orgB }, "intrus"),
      /MEMBERSHIP_REQUIRED/,
    );
  });

  it("la FK composite refuse un message au mauvais propriétaire", async () => {
    const conv = await store.create(a, "FK");
    await assert.rejects(
      pool.query(
        `INSERT INTO messages (conversation_id, organization_id, user_id, role, content)
         VALUES ($1, $2, $3, 'user', 'x')`,
        [conv.id, orgB, bob],
      ),
    );
  });

  it("garde l'ordre user puis assistant", async () => {
    const conv = await store.create(a);
    await store.appendExchange(a, conv.id, "question", "réponse");
    const msgs = await store.getMessages(a, conv.id);
    assert.deepEqual(msgs?.map((m) => m.role), ["user", "assistant"]);
  });
});