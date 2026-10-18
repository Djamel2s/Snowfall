import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresConversationStore } from "../conversations/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { MemoryShareStore, PostgresShareStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Partages : expiration (mémoire)", () => {
  it("un lien expiré ne s'ouvre plus et disparaît de la liste", async () => {
    const store = new MemoryShareStore();
    const tenant = { userId: "u", organizationId: "o" };
    const share = await store.create(tenant, { conversationId: "c", title: "T", days: 1, snapshot: { messages: [] } });
    assert.ok(await store.open(tenant, share.token));
    store.now = () => Date.now() + 2 * 86_400_000;
    assert.equal(await store.open(tenant, share.token), null);
    assert.deepEqual(await store.list(tenant, "c"), []);
  });
});

describe("Partages : PostgreSQL (RLS, chiffrement)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let shares: PostgresShareStore;
  let conversations: PostgresConversationStore;
  const org = randomUUID();
  const other = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const eve = randomUUID();
  const a = { userId: alice, organizationId: org };
  const b = { userId: bob, organizationId: org };
  const e = { userId: eve, organizationId: other };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    shares = new PostgresShareStore(pool, keyring);
    conversations = new PostgresConversationStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $4), ($2, $5), ($3, $6)", [alice, bob, eve, `${alice}@t.local`, `${bob}@t.local`, `${eve}@t.local`]);
    await owner.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'member'), ($1, $4, 'member'), ($2, $5, 'member')",
      [org, other, alice, bob, eve],
    );
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob, eve]]);
    await pool.end();
    await owner.end();
  });

  it("lu par l'organisation, géré par son auteur, chiffré, effacé avec la conversation", async () => {
    const conversation = await conversations.create(a, "Projet Orion");
    const share = await shares.create(a, { conversationId: conversation.id, title: "Projet Orion", days: 7, snapshot: { messages: [{ role: "user", content: "Budget Orion ?", createdAt: "" }] } });

    const opened = await shares.open(b, share.token);
    assert.equal(opened?.title, "Projet Orion");
    assert.equal(opened?.mine, false);
    assert.equal(await shares.open(e, share.token), null);
    // Un collègue ne liste ni ne supprime le lien.
    assert.deepEqual(await shares.list(b, conversation.id), []);
    assert.equal(await shares.delete(b, share.id), false);
    const direct = await withTenant(pool, b, (client) => client.query("DELETE FROM conversation_shares WHERE id = $1", [share.id]));
    assert.equal(direct.rowCount, 0);
    assert.deepEqual((await shares.list(a, conversation.id)).map((item) => item.token), [share.token]);

    // Rien en clair, pas même le jeton ; un jeton en clair est refusé.
    const raw = await withTenant(owner, a, (client) => client.query("SELECT token, token_hash, title, snapshot FROM conversation_shares WHERE id = $1", [share.id]));
    assert.ok(!JSON.stringify(raw.rows).includes("Orion") && !JSON.stringify(raw.rows).includes(share.token));
    await assert.rejects(withTenant(owner, a, (client) => client.query("UPDATE conversation_shares SET token = 'clair' WHERE id = $1", [share.id])), /conversation_shares_encrypted_check/);
    // Durée bornée à 31 jours.
    await assert.rejects(withTenant(owner, a, (client) => client.query("UPDATE conversation_shares SET expires_at = created_at + interval '90 days' WHERE id = $1", [share.id])), /conversation_shares_expiry_check/);

    await conversations.delete(a, conversation.id);
    assert.equal(await shares.open(b, share.token), null);
  });
});
