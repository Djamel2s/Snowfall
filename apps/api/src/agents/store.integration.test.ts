import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresConversationStore } from "../conversations/store.js";
import { PostgresAgentStore, type AgentInput } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

const input: AgentInput = {
  name: "Analyste confidentiel",
  avatar: { kind: "alien", color: "mint", eyes: "sleepy", accessory: "none" },
  instructions: "Projet Orion : ne jamais citer le client.",
  provider: "mistral",
  model: "mistral-small-latest",
};

describe("PostgresAgentStore", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let agents: PostgresAgentStore;
  let conversations: PostgresConversationStore;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const a = { userId: alice, organizationId: orgA };
  const b = { userId: bob, organizationId: orgB };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    agents = new PostgresAgentStore(pool, keyring);
    conversations = new PostgresConversationStore(pool, keyring);

    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [orgA, orgB]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $3), ($2, $4)", [
      alice, bob, `${alice}@test.local`, `${bob}@test.local`,
    ]);
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

  it("crée, relit et liste un agent de l'organisation", async () => {
    const created = await agents.create(a, input);

    assert.equal(created.createdBy, alice);
    assert.deepEqual((await agents.get(a, created.id))?.instructions, input.instructions);
    assert.ok((await agents.list(a)).some((agent) => agent.id === created.id));
  });

  it("chiffre nom, avatar et instructions en base", async () => {
    const created = await agents.create(a, input);
    const raw = await withTenant(owner, a, (client) =>
      client.query("SELECT * FROM agents WHERE id = $1", [created.id]),
    );
    const serialized = JSON.stringify(raw.rows);

    assert.ok(!serialized.includes("Orion"));
    assert.ok(!serialized.includes("Analyste"));
    assert.ok(!serialized.includes("matcha"));
  });

  it("n'expose ni ne modifie les agents d'une autre organisation", async () => {
    const created = await agents.create(a, input);

    assert.equal(await agents.get(b, created.id), null);
    assert.ok(!(await agents.list(b)).some((agent) => agent.id === created.id));
    assert.equal(await agents.update(b, created.id, { ...input, name: "pirate" }), null);
    assert.equal(await agents.delete(b, created.id), false);
    assert.equal((await agents.get(a, created.id))?.name, input.name);
  });

  it("refuse de lier une conversation à l'agent d'une autre organisation", async () => {
    const foreign = await agents.create(a, input);

    await assert.rejects(conversations.create(b, "x", foreign.id), /AGENT_NOT_FOUND/);
    // Même en contournant le store, la clé étrangère composite bloque.
    await assert.rejects(
      withTenant(pool, b, (client) =>
        client.query(
          "INSERT INTO conversations (organization_id, user_id, agent_id) VALUES ($1, $2, $3)",
          [orgB, bob, foreign.id],
        ),
      ),
      /conversations_agent_fk/,
    );
  });

  it("supprimer un agent conserve ses conversations", async () => {
    const agent = await agents.create(a, input);
    const conversation = await conversations.create(a, "Avec agent", agent.id);
    await conversations.appendExchange(a, conversation.id, "question", "réponse");

    assert.equal(await agents.delete(a, agent.id), true);

    const kept = await conversations.get(a, conversation.id);
    assert.equal(kept?.agentId, null);
    assert.equal((await conversations.getMessages(a, conversation.id))?.length, 2);
  });

  it("refuse un profil non chiffré (contrainte)", async () => {
    await assert.rejects(
      withTenant(pool, a, (client) =>
        client.query(
          "INSERT INTO agents (organization_id, provider, model, profile_enc) VALUES ($1, 'mistral', 'm', '{}')",
          [orgA],
        ),
      ),
      /agents_profile_encrypted_check/,
    );
  });
});
