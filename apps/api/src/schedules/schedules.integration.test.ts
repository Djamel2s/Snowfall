import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresAgentStore } from "../agents/store.js";
import { PostgresConversationStore } from "../conversations/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { PostgresScheduleStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Agents planifiés : PostgreSQL (privés, chiffrés, prise à bail)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresScheduleStore;
  let agents: PostgresAgentStore;
  let conversations: PostgresConversationStore;
  const org = randomUUID();
  const [alice, bob] = [randomUUID(), randomUUID()];
  const avatar = { kind: "alien" as const, color: "mint" as const, eyes: "sleepy" as const, accessory: "none" as const };
  const as = (userId: string) => ({ userId, organizationId: org });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    store = new PostgresScheduleStore(pool, keyring);
    agents = new PostgresAgentStore(pool, keyring);
    conversations = new PostgresConversationStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A')", [org]);
    for (const id of [alice, bob]) {
      await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@t.local`]);
      await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, id]);
    }
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = $1", [org]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob]]);
    await pool.end();
    await owner.end();
  });

  async function schedule(userId: string, nextRunAt: Date | null, kind: "schedule" | "knowledge" = "schedule") {
    const agent = await agents.create(as(userId), { name: "Veille", avatar, instructions: "", provider: "mistral", model: "mistral-small-latest" });
    const conversation = await conversations.create(as(userId), "Veille", agent.id);
    return (await store.create(as(userId), {
      agentId: agent.id,
      conversationId: conversation.id,
      name: "Veille concurrentielle Orion",
      prompt: "Surveille le projet Orion.",
      kind,
      rule: kind === "schedule" ? { cadence: "daily", hour: 7 } : null,
      timezone: "Europe/Paris",
      nextRunAt,
    }))!;
  }

  it("privée et chiffrée : son auteur seul la voit ; le texte n'est jamais en clair", async () => {
    const mine = await schedule(alice, new Date(Date.now() + 3_600_000));
    assert.equal((await store.list(as(alice)))[0]!.name, "Veille concurrentielle Orion");
    assert.deepEqual(await store.list(as(bob)), []);
    assert.equal(await store.delete(as(bob), mine.id), false);
    const raw = await owner.query("SELECT name_enc, prompt_enc FROM agent_schedules");
    // RLS imposée même au propriétaire de la table : sans contexte, rien.
    assert.equal(raw.rows.length, 0);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)", [org, alice]);
      const rows = (await client.query("SELECT name_enc, prompt_enc FROM agent_schedules")).rows;
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(rows).includes("Orion"));
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    // Le rôle applicatif ne lit pas la table sans contexte, et n'appelle la fonction de prise en charge que telle quelle.
    assert.deepEqual((await pool.query("SELECT * FROM agent_schedules")).rows, []);
    // La file d'échéances (sans contenu) n'est accessible que par la fonction de prise en charge.
    await assert.rejects(pool.query("SELECT * FROM agent_schedule_queue"), /permission denied/);
  });

  it("prise à bail : une tâche due n'est rendue qu'une fois ; auteur parti : jamais", async () => {
    const due = await schedule(alice, new Date(Date.now() - 1_000));
    const claimed = (await store.claim(600, 10)).filter((item) => item.scheduleId === due.id);
    assert.deepEqual(claimed.map((item) => [item.userId, item.role]), [[alice, "member"]]);
    // Deuxième instance, même instant : rien (bail en cours).
    assert.equal((await store.claim(600, 10)).some((item) => item.scheduleId === due.id), false);
    // L'auteur modifie sa tâche pendant l'exécution : le bail tient toujours.
    await store.setEnabled(as(alice), due.id, true, new Date(Date.now() - 1_000));
    assert.equal((await store.claim(600, 10)).some((item) => item.scheduleId === due.id), false);
    // Fin de passage sans statut (déclencheur sans nouveauté) : aucune contrainte violée.
    await store.finish(as(alice), due.id, { status: null, nextRunAt: new Date(Date.now() - 1_000), ran: false, checked: true });
    assert.equal((await store.claim(600, 10)).some((item) => item.scheduleId === due.id), true);
    await store.finish(as(alice), due.id, { status: "done", nextRunAt: new Date(Date.now() + 86_400_000), ran: true, checked: false });

    const left = await schedule(bob, new Date(Date.now() - 1_000));
    await owner.query("DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", [org, bob]);
    assert.equal((await store.claim(600, 10)).some((item) => item.scheduleId === left.id), false);
  });

  it("trois échecs de suite : désactivée ; réactivée : compteur remis à zéro", async () => {
    const flaky = await schedule(alice, new Date(Date.now() + 3_600_000));
    for (let index = 0; index < 3; index++) await store.finish(as(alice), flaky.id, { status: "error", nextRunAt: new Date(Date.now() + 3_600_000), ran: true, checked: false });
    const disabled = await store.get(as(alice), flaky.id);
    assert.deepEqual([disabled!.enabled, disabled!.failures], [false, 3]);
    const enabled = await store.setEnabled(as(alice), flaky.id, true, new Date(Date.now() + 3_600_000));
    assert.deepEqual([enabled!.enabled, enabled!.failures], [true, 0]);
  });
});
