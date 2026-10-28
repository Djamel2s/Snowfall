import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { withTenant } from "../db/tenant.js";
import { hashKey, PostgresApiKeyStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Clés d'API : empreinte seule, RLS administrateurs, recherche contrôlée", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let keys: PostgresApiKeyStore;
  const org = randomUUID();
  const other = randomUUID();
  const [admin, member, stranger] = [randomUUID(), randomUUID(), randomUUID()];
  const agent = randomUUID();
  const as = (userId: string, organizationId = org) => ({ userId, organizationId });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    keys = new PostgresApiKeyStore(pool);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    await owner.query("INSERT INTO users (id, email) SELECT id, id || '@t.local' FROM unnest($1::uuid[]) AS id", [[admin, member, stranger]]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'admin'), ($1, $4, 'member'), ($2, $5, 'admin')", [org, other, admin, member, stranger]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[admin, member, stranger]]);
    await pool.end();
    await owner.end();
  });

  it("créée par un administrateur ; seule l'empreinte est en base ; invisible d'un membre et d'une autre organisation", async () => {
    const created = await keys.create(as(admin), { name: "Intranet RH", agentIds: [agent], expiresAt: new Date(Date.now() + 86_400_000) });
    assert.ok(created);
    assert.equal(await keys.create(as(member), { name: "Moi", agentIds: [agent], expiresAt: new Date(Date.now() + 86_400_000) }), null);

    const raw = await withTenant(pool, as(admin), (client) => client.query("SELECT * FROM api_keys WHERE id = $1", [created.record.id]));
    assert.equal(raw.rowCount, 1);
    assert.ok(!JSON.stringify(raw.rows).includes(created.key.slice(18)), "la clé n'est jamais stockée");
    assert.equal(raw.rows[0].key_hash, hashKey(created.key));

    assert.deepEqual(await keys.list(as(member)), []);
    assert.deepEqual(await keys.list(as(stranger, other)), []);
    // L'index de recherche : aucun droit pour l'application (seule la fonction de recherche le lit).
    await assert.rejects(withTenant(pool, as(admin), (client) => client.query("SELECT count(*) FROM api_key_index")), /permission denied/);
    // Un membre ne fabrique pas une clé à la main.
    await assert.rejects(
      withTenant(pool, as(member), (client) =>
        client.query("INSERT INTO api_keys (organization_id, user_id, name, prefix, key_hash, agent_ids, expires_at) VALUES ($1, $2, 'x', 'snowfall_sk_AAAAAA', $3, $4, now() + interval '1 day')", [org, member, "0".repeat(64), [agent]]),
      ),
    );
  });

  it("recherche : valide tant que le créateur est administrateur ; révoquée ou rétrogradé, plus rien", async () => {
    const created = (await keys.create(as(admin), { name: "Bot", agentIds: [agent], expiresAt: new Date(Date.now() + 86_400_000) }))!;
    const found = await keys.authenticate(created.key);
    assert.deepEqual(found, { keyId: created.record.id, organizationId: org, userId: admin, role: "admin", kind: "api" });
    assert.deepEqual(await keys.agentsFor(found!), [agent]);
    assert.equal(await keys.authenticate(`snowfall_sk_${"A".repeat(46)}`), null);

    await owner.query("UPDATE organization_members SET role = 'member' WHERE organization_id = $1 AND user_id = $2", [org, admin]);
    assert.equal(await keys.authenticate(created.key), null);
    await owner.query("UPDATE organization_members SET role = 'admin' WHERE organization_id = $1 AND user_id = $2", [org, admin]);
    assert.ok(await keys.authenticate(created.key));

    assert.equal(await keys.revoke(as(admin), created.record.id), true);
    assert.equal(await keys.authenticate(created.key), null);
    assert.equal(await keys.agentsFor(found!), null);
    // Une clé révoquée ne se « dé-révoque » pas par l'application (droit limité aux colonnes d'usage).
    await assert.rejects(withTenant(pool, as(admin), (client) => client.query("UPDATE api_keys SET agent_ids = $1 WHERE id = $2", [[agent, agent], created.record.id])));
  });

  it("contraintes : étiquette sur une ligne, 366 jours au plus, au moins un agent", async () => {
    await assert.rejects(keys.create(as(admin), { name: "a\nb", agentIds: [agent], expiresAt: new Date(Date.now() + 86_400_000) }), /api_keys_name_check/);
    await assert.rejects(keys.create(as(admin), { name: "Long", agentIds: [agent], expiresAt: new Date(Date.now() + 400 * 86_400_000) }), /api_keys_expiry_check/);
    await assert.rejects(keys.create(as(admin), { name: "Vide", agentIds: [], expiresAt: new Date(Date.now() + 86_400_000) }), /api_keys_agents_check/);
  });
});
