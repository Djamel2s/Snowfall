import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresConversationStore } from "./store.js";

// TEST_DATABASE_URL : rôle applicatif (soumis à RLS et aux droits minimaux).
// TEST_DATABASE_MIGRATION_URL : propriétaire du schéma, pour les fixtures.
const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe(
  "PostgresConversationStore : isolation des tenants et chiffrement",
  { skip: !appUrl || !ownerUrl },
  () => {
    let pool: Pool;
    let owner: Pool;
    let store: PostgresConversationStore;
    const orgA = randomUUID();
    const orgB = randomUUID();
    const alice = randomUUID();
    const bob = randomUUID();
    const a = { userId: alice, organizationId: orgA };
    const b = { userId: bob, organizationId: orgB };

    before(async () => {
      pool = new Pool({ connectionString: appUrl });
      owner = new Pool({ connectionString: ownerUrl });
      store = new PostgresConversationStore(
        pool,
        new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32))),
      );
      await owner.query(
        "INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')",
        [orgA, orgB],
      );
      await owner.query(
        "INSERT INTO users (id, email) VALUES ($1, $3), ($2, $4)",
        [alice, bob, `${alice}@test.local`, `${bob}@test.local`],
      );
      await owner.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $3, 'member'), ($2, $4, 'member')`,
        [orgA, orgB, alice, bob],
      );
    });

    after(async () => {
      await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
      await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
      await pool.end();
      await owner.end();
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

    it("garde l'ordre user puis assistant et relit le clair", async () => {
      const conv = await store.create(a);
      await store.appendExchange(a, conv.id, "question", "réponse");
      const msgs = await store.getMessages(a, conv.id);
      assert.deepEqual(msgs?.map((m) => [m.role, m.content]), [
        ["user", "question"],
        ["assistant", "réponse"],
      ]);
      const listed = (await store.list(a)).find((c) => c.id === conv.id);
      assert.equal(listed?.title, "question");
    });

    it("ne stocke jamais le contenu ni le titre en clair", async () => {
      const conv = await store.create(a, "Titre confidentiel");
      await store.appendExchange(a, conv.id, "numéro de sécu 1 85 05", "noté");

      const raw = await withTenant(owner, a, (client) =>
        client.query<{ content: string; title: string }>(
          `SELECT m.content, c.title FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE m.conversation_id = $1`,
          [conv.id],
        ),
      );
      assert.equal(raw.rowCount, 2);
      for (const row of raw.rows) {
        assert.match(row.content, /^1:v1\./);
        assert.ok(!row.content.includes("sécu"));
        assert.ok(!row.title.includes("confidentiel"));
      }
    });

    it("refuse l'écriture d'un message en clair (contrainte)", async () => {
      const conv = await store.create(a);
      await assert.rejects(
        withTenant(pool, a, (client) =>
          client.query(
            `INSERT INTO messages (conversation_id, organization_id, user_id, role, content)
             VALUES ($1, $2, $3, 'user', 'en clair')`,
            [conv.id, orgA, alice],
          ),
        ),
        /messages_content_encrypted_check/,
      );
    });

    it("un chiffré copié vers une autre ligne ne se déchiffre pas (AAD)", async () => {
      const conv = await store.create(a);
      await store.appendExchange(a, conv.id, "original", "réponse");

      await withTenant(owner, a, (client) =>
        client.query(
          `UPDATE messages SET content = (
             SELECT content FROM messages
             WHERE conversation_id = $1 AND role = 'user'
           )
           WHERE conversation_id = $1 AND role = 'assistant'`,
          [conv.id],
        ),
      );

      await assert.rejects(store.getMessages(a, conv.id), /DECRYPTION_FAILED/);
    });

    it("RLS : sans contexte tenant, aucune ligne n'est visible", async () => {
      await store.create(a, "visible seulement avec contexte");
      const conversations = await pool.query("SELECT id FROM conversations");
      const messages = await pool.query("SELECT id FROM messages");
      const keys = await pool.query("SELECT organization_id FROM organization_keys");
      assert.equal(conversations.rowCount, 0);
      assert.equal(messages.rowCount, 0);
      assert.equal(keys.rowCount, 0);
    });

    it("RLS : le contexte d'un tenant ne voit ni ne modifie celles d'un autre", async () => {
      const conv = await store.create(a, "A");
      await withTenant(pool, b, async (client) => {
        const visible = await client.query("SELECT 1 FROM conversations WHERE id = $1", [conv.id]);
        assert.equal(visible.rowCount, 0);
        const deleted = await client.query("DELETE FROM conversations WHERE id = $1", [conv.id]);
        assert.equal(deleted.rowCount, 0);
        const key = await client.query(
          "SELECT 1 FROM organization_keys WHERE organization_id = $1",
          [orgA],
        );
        assert.equal(key.rowCount, 0);
      });
      await assert.rejects(
        withTenant(pool, b, (client) =>
          client.query(
            "INSERT INTO conversations (organization_id, user_id) VALUES ($1, $2)",
            [orgA, alice],
          ),
        ),
        /row-level security/,
      );
    });

    it("la FK composite refuse un message au mauvais propriétaire", async () => {
      const conv = await store.create(a, "FK");
      await assert.rejects(
        withTenant(pool, b, (client) =>
          client.query(
            `INSERT INTO messages (conversation_id, organization_id, user_id, role, content)
             VALUES ($1, $2, $3, 'user', '1:v1.AAAA.AAAA')`,
            [conv.id, orgB, bob],
          ),
        ),
        /messages_conversation_owner_fk/,
      );
    });

    it("le rôle applicatif ne peut pas modifier les appartenances", async () => {
      await assert.rejects(
        pool.query(
          "UPDATE organization_members SET role = 'owner' WHERE user_id = $1",
          [alice],
        ),
        /permission denied/,
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)",
          [orgB, alice],
        ),
        /permission denied/,
      );
    });

    it("le journal d'audit est en ajout seul pour le rôle applicatif", async () => {
      await pool.query(
        "INSERT INTO audit_events (event_type, outcome) VALUES ('test.event', 'success')",
      );
      await assert.rejects(pool.query("SELECT * FROM audit_events"), /permission denied/);
      await assert.rejects(pool.query("DELETE FROM audit_events"), /permission denied/);
      await assert.rejects(
        owner.query("DELETE FROM audit_events WHERE event_type = 'test.event'"),
        /ajout seul/,
      );
    });
  },
);
