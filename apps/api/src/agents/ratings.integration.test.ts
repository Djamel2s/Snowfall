import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { PostgresConversationStore } from "../conversations/store.js";
import { PostgresAgentRatingStore } from "./ratings.js";
import { PostgresAgentStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Taux de 👍 par agent : PostgreSQL (agrégat, seuil, isolation)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let conversations: PostgresConversationStore;
  let agents: PostgresAgentStore;
  let ratings: PostgresAgentRatingStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const users = Array.from({ length: 6 }, () => randomUUID());
  const outsider = randomUUID();
  const tenant = (userId: string) => ({ userId, organizationId: org });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    conversations = new PostgresConversationStore(pool, keyring);
    agents = new PostgresAgentStore(pool, keyring);
    ratings = new PostgresAgentRatingStore(pool);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    for (const id of [...users, outsider]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
    for (const id of users) await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, id]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [other, outsider]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[...users, outsider]]);
    await pool.end();
    await owner.end();
  });

  /** Un échange avec l'agent, noté par son auteur. */
  async function rate(userId: string, agentId: string, rating: "up" | "down") {
    const conversation = await conversations.create(tenant(userId), "Q", agentId);
    const exchange = (await conversations.appendExchange(tenant(userId), conversation.id, "Question", "Réponse"))!;
    await conversations.setFeedback(tenant(userId), conversation.id, exchange.assistantMessage.id, { rating, comment: "Avis détaillé de Martin" });
    return { conversationId: conversation.id, messageId: exchange.assistantMessage.id };
  }

  it("absent sous 5 personnes ; ensuite seul l'agrégat de l'organisation, jamais un commentaire", async () => {
    const agent = await agents.create(tenant(users[0]!), { name: "Juriste", avatar: { kind: "alien", color: "mint", eyes: "sleepy", accessory: "none" }, instructions: "", provider: "mistral", model: "mistral-small-latest" });
    const votes = [];
    for (const [index, userId] of users.slice(0, 4).entries()) votes.push(await rate(userId, agent.id, index === 3 ? "down" : "up"));
    assert.deepEqual(await ratings.ratings(tenant(users[0]!)), {});
    // Une seule personne qui note beaucoup ne fait pas un taux.
    for (let index = 0; index < 3; index += 1) await rate(users[0]!, agent.id, "up");
    assert.deepEqual(await ratings.ratings(tenant(users[0]!)), {});

    votes.push(await rate(users[4]!, agent.id, "up"));
    assert.deepEqual(await ratings.ratings(tenant(users[5]!)), { [agent.id]: { up: 7, total: 8 } });
    // Autre organisation : rien.
    assert.deepEqual(await ratings.ratings({ userId: outsider, organizationId: other }), {});
    // Le rôle applicatif ne lit pas la table de comptage.
    await assert.rejects(pool.query("SELECT * FROM agent_feedback"), /permission denied/);
    const raw = await owner.query("SELECT * FROM agent_feedback WHERE agent_id = $1", [agent.id]);
    assert.ok(!JSON.stringify(raw.rows).includes("Martin"));

    // Avis changé, puis retiré, puis conversation effacée : l'agrégat suit.
    await conversations.setFeedback(tenant(users[3]!), votes[3]!.conversationId, votes[3]!.messageId, { rating: "up" });
    assert.deepEqual(await ratings.ratings(tenant(users[0]!)), { [agent.id]: { up: 8, total: 8 } });
    // Avis retiré : 4 personnes seulement, plus de taux.
    await conversations.setFeedback(tenant(users[2]!), votes[2]!.conversationId, votes[2]!.messageId, null);
    assert.deepEqual(await ratings.ratings(tenant(users[0]!)), {});
    votes.push(await rate(users[5]!, agent.id, "down"));
    assert.deepEqual(await ratings.ratings(tenant(users[0]!)), { [agent.id]: { up: 7, total: 8 } });
    // Conversation effacée : son avis disparaît avec elle.
    await conversations.delete(tenant(users[5]!), votes[5]!.conversationId);
    assert.deepEqual(await ratings.ratings(tenant(users[0]!)), {});

    // Agent supprimé : ses compteurs disparaissent.
    await agents.delete(tenant(users[0]!), agent.id);
    assert.equal((await owner.query("SELECT 1 FROM agent_feedback WHERE agent_id = $1", [agent.id])).rowCount, 0);
  });
});
