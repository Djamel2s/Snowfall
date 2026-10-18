import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { MAX_MEMORIES, MemoryFullError, PostgresUserMemoryStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Mémoire : PostgreSQL (RLS propriétaire, chiffrement, limite)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresUserMemoryStore;
  const org = randomUUID();
  const [alice, bob] = [randomUUID(), randomUUID()];
  const a = { userId: alice, organizationId: org };
  const b = { userId: bob, organizationId: org };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    store = new PostgresUserMemoryStore(pool, new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32))));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A')", [org]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $3), ($2, $4)", [alice, bob, `${alice}@t.local`, `${bob}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin')", [org, alice, bob]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = $1", [org]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
    await pool.end();
    await owner.end();
  });

  it("invisible des collègues (admin compris), chiffrée, bornée, effaçable", async () => {
    const memory = await store.add(a, "Dossier Orion : négociation en cours");
    assert.deepEqual((await store.list(a)).map((item) => item.content), ["Dossier Orion : négociation en cours"]);
    assert.deepEqual(await store.list(b), []);
    assert.equal(await store.delete(b, memory.id), false);
    const peek = await withTenant(pool, b, (client) => client.query("SELECT 1 FROM user_memories WHERE id = $1", [memory.id]));
    assert.equal(peek.rowCount, 0);
    const raw = await withTenant(owner, a, (client) => client.query("SELECT content FROM user_memories WHERE id = $1", [memory.id]));
    assert.ok(!/orion/i.test(JSON.stringify(raw.rows)));
    await assert.rejects(withTenant(owner, a, (client) => client.query("INSERT INTO user_memories (organization_id, user_id, content) VALUES ($1, $2, 'clair')", [org, alice])), /user_memories_encrypted_check/);
    // Pas d'écriture au nom d'un autre, même en SQL direct.
    await assert.rejects(withTenant(pool, b, (client) => client.query("INSERT INTO user_memories (organization_id, user_id, content) VALUES ($1, $2, '1:v1.AAAA.BBBB')", [org, alice])), /row-level security/);

    await Promise.all(Array.from({ length: MAX_MEMORIES + 3 }, (_, index) => store.add(a, `Fait ${index}`).catch((error: unknown) => error)));
    assert.equal((await store.list(a)).length, MAX_MEMORIES);
    await assert.rejects(store.add(a, "Un de trop"), MemoryFullError);
    assert.equal(await store.clear(a), MAX_MEMORIES);
    assert.deepEqual(await store.list(a), []);
  });
});
