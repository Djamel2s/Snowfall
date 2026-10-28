import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresAgentStore } from "../agents/store.js";
import { PostgresConversationStore } from "../conversations/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { PostgresSharingStore } from "../sharing/store.js";
import { AdminForbiddenError, PostgresAdminOverviewStore } from "./overview.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Pilotage : PostgreSQL (comptage sans contenu, administrateurs, seuil, isolation)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let conversations: PostgresConversationStore;
  let agents: PostgresAgentStore;
  let keyring: OrganizationKeyring;
  let overview: PostgresAdminOverviewStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const admin = randomUUID();
  const users = Array.from({ length: 5 }, () => randomUUID());
  const outsider = randomUUID();
  const tenant = (userId: string, organizationId = org) => ({ userId, organizationId });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    conversations = new PostgresConversationStore(pool, keyring);
    agents = new PostgresAgentStore(pool, keyring);
    overview = new PostgresAdminOverviewStore(pool);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    for (const id of [admin, ...users, outsider]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [org, admin]);
    for (const id of users) await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, id]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [other, outsider]);
  });

  after(async () => {
    await owner.query("DELETE FROM member_activity WHERE organization_id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[admin, ...users, outsider]]);
    await pool.end();
    await owner.end();
  });

  async function talk(userId: string, agentId: string | null, times = 1) {
    const conversation = await conversations.create(tenant(userId), "Q", agentId ?? undefined);
    for (let index = 0; index < times; index += 1) await conversations.appendExchange(tenant(userId), conversation.id, "Ma question confidentielle sur Martin", "Réponse");
    return conversation.id;
  }

  it("chaque message de l'utilisateur est compté ; seuls des totaux sortent, pour un administrateur", async () => {
    const agent = await agents.create(tenant(admin), { name: "Assistant RH", avatar: { kind: "alien", color: "mint", eyes: "sleepy", accessory: "none" }, instructions: "", provider: "mistral", model: "mistral-small-latest" });
    await new PostgresSharingStore(pool, keyring).setGrants(tenant(admin), "agent", agent.id, [{ principal: { type: "organization" }, permission: "view" }]);
    // 4 personnes avec l'agent (dont une très active), une sans agent.
    for (const [index, userId] of users.slice(0, 4).entries()) await talk(userId, agent.id, index === 0 ? 6 : 1);
    await talk(users[4]!, null, 2);

    let result = await overview.overview(tenant(admin), 7);
    assert.equal(result.days.length, 7);
    assert.deepEqual(result.days.at(-1), { day: result.days.at(-1)!.day, users: 5, messages: 11 });
    assert.equal(result.active7, 5);
    // 4 personnes : l'usage de l'agent n'apparaît pas encore (il désignerait presque quelqu'un).
    assert.deepEqual(result.agents, []);

    await talk(users[4]!, agent.id);
    result = await overview.overview(tenant(admin), 30);
    assert.deepEqual(result.agents, [{ agentId: agent.id, messages: 10, users: 5 }]);
    assert.equal(result.tokens.length, 6);

    // Un membre, ou un administrateur d'une autre organisation : refusés par la base.
    await assert.rejects(overview.overview(tenant(users[0]!), 30), AdminForbiddenError);
    const elsewhere = await overview.overview(tenant(outsider, other), 30);
    assert.equal(elsewhere.active30, 0);
    assert.deepEqual(elsewhere.agents, []);
    // Administrateur prétendu d'une organisation dont il n'est pas membre : refusé.
    await assert.rejects(overview.overview(tenant(outsider, org), 30), AdminForbiddenError);
    await assert.rejects(overview.overview(tenant(admin), 400), /SNOWFALL_INVALID_PERIOD/);

    // Le rôle applicatif ne lit ni n'écrit la table de comptage ; elle ne contient aucun texte.
    await assert.rejects(pool.query("SELECT * FROM member_activity"), /permission denied/);
    await assert.rejects(pool.query("DELETE FROM member_activity"), /permission denied/);
    const raw = await owner.query("SELECT * FROM member_activity WHERE organization_id = $1", [org]);
    assert.deepEqual(Object.keys(raw.rows[0]!).sort(), ["agent_id", "day", "messages", "organization_id", "user_id"]);
    assert.ok(!JSON.stringify(raw.rows).includes("Martin"));

    // Conversation effacée : l'activité passée reste comptée (on ne réécrit pas l'historique).
    const deleted = await talk(users[1]!, null);
    await conversations.delete(tenant(users[1]!), deleted);
    assert.equal((await overview.overview(tenant(admin), 7)).days.at(-1)!.messages, 13);

    // Copie et import : des messages recopiés, pas une activité du jour.
    const source = await conversations.create(tenant(users[2]!), "Q");
    const exchange = (await conversations.appendExchange(tenant(users[2]!), source.id, "Question", "Réponse"))!;
    assert.ok(await conversations.fork(tenant(users[2]!), source.id, exchange.assistantMessage.id));
    await conversations.importConversation(tenant(users[2]!), "Historique ChatGPT", Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `Ancien message ${index}` })));
    assert.equal((await overview.overview(tenant(admin), 7)).days.at(-1)!.messages, 14);
  });
});
