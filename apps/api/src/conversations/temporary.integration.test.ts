import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresConversationStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Conversations temporaires : PostgreSQL (échéance, purge, contraintes)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresConversationStore;
  const org = randomUUID();
  const alice = randomUUID();
  const a = { userId: alice, organizationId: org };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    store = new PostgresConversationStore(pool, new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32))));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A')", [org]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [alice, `${alice}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, alice]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = $1", [org]);
    await owner.query("DELETE FROM users WHERE id = $1", [alice]);
    await pool.end();
    await owner.end();
  });

  it("hors historique et recherche, échéance à 24 h, purge puis disparition de la file", async () => {
    const temporary = await store.create(a, "Brouillon", undefined, undefined, undefined, { temporary: true });
    const kept = await store.create(a, "Gardée");
    await store.appendExchange(a, kept.id, "Bonjour", "Bonjour !");
    assert.equal(temporary.temporary, true);
    assert.equal(kept.temporary, undefined);
    await store.appendExchange(a, temporary.id, "Code porte 4512 ?", "Voir l'accueil.");
    assert.deepEqual((await store.list(a)).map((item) => item.id), [kept.id]);
    assert.deepEqual(await store.search(a, "4512"), []);
    assert.equal((await store.get(a, temporary.id))?.temporary, true);

    const queued = await owner.query("SELECT organization_id, user_id, expires_at - now() > interval '23 hours' AS later FROM temporary_conversations WHERE conversation_id = $1", [temporary.id]);
    assert.deepEqual(queued.rows, [{ organization_id: org, user_id: alice, later: true }]);
    assert.ok(!(await store.expiredTemporary()).some((item) => item.conversationId === temporary.id));

    await owner.query("UPDATE temporary_conversations SET expires_at = now() - interval '1 minute' WHERE conversation_id = $1", [temporary.id]);
    assert.ok((await store.expiredTemporary()).some((item) => item.conversationId === temporary.id && item.userId === alice));
    assert.equal(await store.delete(a, temporary.id), true);
    assert.equal((await owner.query("SELECT 1 FROM temporary_conversations WHERE conversation_id = $1", [temporary.id])).rowCount, 0);
  });

  it("drapeau figé, jamais dans un projet, file inaccessible au rôle applicatif", async () => {
    const kept = await store.create(a, "Normale");
    await assert.rejects(withTenant(pool, a, (client) => client.query("UPDATE conversations SET temporary = true WHERE id = $1", [kept.id])), /immutable/);
    const temporary = await store.create(a, "Temp", undefined, undefined, undefined, { temporary: true });
    const project = randomUUID();
    await withTenant(pool, a, (client) => client.query("INSERT INTO projects (id, organization_id, user_id, name) VALUES ($1, $2, $3, '1:v1.AAAA.BBBB')", [project, org, alice]));
    await assert.rejects(withTenant(pool, a, (client) => client.query("UPDATE conversations SET project_id = $2 WHERE id = $1", [temporary.id, project])), /conversations_temporary_project_check/);
    await assert.rejects(pool.query("SELECT * FROM temporary_conversations"), /permission denied/);
    await assert.rejects(pool.query("INSERT INTO temporary_conversations VALUES ($1, $2, $3, now())", [kept.id, org, alice]), /permission denied/);
  });
});
