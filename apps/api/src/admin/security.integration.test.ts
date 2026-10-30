import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresConversationStore } from "../conversations/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { AdminForbiddenError } from "./overview.js";
import { PostgresSecurityStore } from "./security.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Sécurité : PostgreSQL (conservation, file d'activité, journal des administrateurs)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let store: PostgresSecurityStore;
  let conversations: PostgresConversationStore;
  const [org, other] = [randomUUID(), randomUUID()];
  const [admin, member, outsider] = [randomUUID(), randomUUID(), randomUUID()];
  const as = (userId: string, organizationId = org) => ({ userId, organizationId });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    store = new PostgresSecurityStore(pool);
    conversations = new PostgresConversationStore(pool, new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32))));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    await owner.query("INSERT INTO users (id, email) SELECT id, id || '@t.local' FROM unnest($1::uuid[]) AS id", [[admin, member, outsider]]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'admin'), ($1, $4, 'member'), ($2, $5, 'admin')", [org, other, admin, member, outsider]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[admin, member, outsider]]);
    await pool.end();
    await owner.end();
  });

  const age = (userId: string, ids: string[], days: number, organizationId = org) =>
    withTenant(pool, as(userId, organizationId), (client) => client.query(`UPDATE conversations SET updated_at = now() - interval '${days} days' WHERE id = ANY($1)`, [ids]));

  it("conservation : seules les conversations sans activité depuis la durée de LEUR organisation sortent ; temporaires exclues", async () => {
    const old = await conversations.create(as(member), "Ancienne");
    const fresh = await conversations.create(as(member), "Récente");
    const temporary = await conversations.create(as(member), "Brouillon", undefined, undefined, undefined, { temporary: true });
    const elsewhere = await conversations.create(as(outsider, other), "Ailleurs");
    await age(member, [old.id, temporary.id], 120);
    await age(outsider, [elsewhere.id], 400, other);

    // Aucune durée choisie : rien n'échoit.
    const mine = async () => (await store.expired()).filter((item) => ([org, other] as string[]).includes(item.organizationId)).map((item) => item.conversationId);
    assert.deepEqual(await mine(), []);
    // Un membre ne fixe pas la durée (refus par la base) ; l'administrateur, oui.
    assert.equal(await store.setRetention(as(member), 30), false);
    assert.equal(await store.setRetention(as(admin), 90), true);
    assert.equal(await store.retention(as(member)), 90);
    assert.deepEqual(await mine(), [old.id]);
    // Activité nouvelle : la conversation n'échoit plus.
    await conversations.appendExchange(as(member), old.id, "Encore là ?", "Oui.");
    assert.deepEqual(await mine(), []);
    void fresh;

    // La file ne contient aucun texte, et l'application n'y a aucun droit.
    const columns = await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'conversation_activity' ORDER BY column_name");
    assert.deepEqual(columns.rows.map((row) => row.column_name), ["conversation_id", "last_activity", "organization_id", "user_id"]);
    await assert.rejects(pool.query("SELECT * FROM conversation_activity"), /permission denied/);
    await assert.rejects(store.setRetention(as(admin), 5), /organization_retention_days_check/);
  });

  it("journal : administrateurs de l'organisation seulement ; lecture directe impossible pour l'application", async () => {
    const insert = (organizationId: string, eventType: string, outcome = "success") =>
      pool.query("INSERT INTO audit_events (event_type, outcome, actor_user_id, organization_id, details) VALUES ($1, $2, $3, $4, '{}')", [eventType, outcome, member, organizationId]);
    await insert(org, "auth.login");
    await insert(org, "security.malware_detected", "denied");
    await insert(other, "auth.login");

    const events = await store.audit(as(admin), { limit: 50 });
    assert.deepEqual(events.map((entry) => entry.eventType), ["security.malware_detected", "auth.login"]);
    assert.deepEqual((await store.audit(as(admin), { limit: 50, problems: true })).map((entry) => entry.eventType), ["security.malware_detected"]);
    assert.deepEqual((await store.audit(as(admin), { limit: 50, categories: ["auth"] })).map((entry) => entry.eventType), ["auth.login"]);
    // Page suivante : après le dernier vu.
    assert.deepEqual((await store.audit(as(admin), { limit: 50, before: { at: events[0]!.occurredAt, id: events[0]!.id } })).map((entry) => entry.eventType), ["auth.login"]);

    await assert.rejects(store.audit(as(member), { limit: 50 }), AdminForbiddenError);
    await assert.rejects(store.audit(as(outsider, org), { limit: 50 }), AdminForbiddenError);
    assert.deepEqual((await store.audit(as(outsider, other), { limit: 50 })).map((entry) => entry.eventType), ["auth.login"]);
    await assert.rejects(store.audit(as(admin), { limit: 50, categories: ["auth' OR 1=1 --"] }), /SNOWFALL_INVALID_CATEGORY/);
    await assert.rejects(pool.query("SELECT * FROM audit_events"), /permission denied/);
  });
});
