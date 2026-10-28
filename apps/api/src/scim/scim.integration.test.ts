import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { PostgresApiKeyStore } from "../apikeys/store.js";
import { withTenant } from "../db/tenant.js";
import { PostgresMemberStore, provisionIdentity } from "../workspace/members.js";
import { PostgresScimUserStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("SCIM : l'annuaire décide qui entre (connexion, SSO compris)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let scim: PostgresScimUserStore;
  let keys: PostgresApiKeyStore;
  let members: PostgresMemberStore;
  const org = randomUUID();
  const admin = randomUUID();
  const member = randomUUID();
  const alias = `scim-${randomUUID().slice(0, 8)}`;
  const issuer = `http://idp.test/${randomUUID()}`;
  const as = (userId: string) => ({ userId, organizationId: org });
  const mail = (name: string) => `${name}@${alias}.test`;
  const isMember = async (userId: string | null) =>
    userId !== null && (await owner.query("SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2", [org, userId])).rowCount === 1;

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    scim = new PostgresScimUserStore(pool);
    keys = new PostgresApiKeyStore(pool);
    members = new PostgresMemberStore(pool);
    await owner.query("INSERT INTO organizations (id, name, sso_alias, sso_default_role) VALUES ($1, 'Acme', $2, 'member')", [org, alias]);
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)", [admin, `${admin}@t.local`, member, `${member}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [org, admin, member]);
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = $1", [org]);
    await owner.query("DELETE FROM users WHERE id = ANY($1) OR email LIKE $2", [[admin, member], `%@${alias}.test`]);
    await pool.end();
    await owner.end();
  });

  it("sans SCIM : tout membre de l'annuaire entre par le SSO (comportement d'avant)", async () => {
    const before = await provisionIdentity(pool, { issuer, subject: "jit-1", email: mail("jit"), emailVerified: true, ssoAliases: [alias] });
    assert.ok(await isMember(before.userId));
  });

  it("avec une clé SCIM : seul un compte SCIM actif entre ; désactivé, il ne revient pas par le SSO", async () => {
    // L'administrateur crée la clé : l'organisation passe sous l'annuaire (même sans aucun compte).
    assert.ok(await keys.create(as(admin), { kind: "scim", name: "Entra ID", agentIds: [], expiresAt: new Date(Date.now() + 86_400_000) }));
    const stranger = await provisionIdentity(pool, { issuer, subject: "jit-2", email: mail("inconnu"), emailVerified: true, ssoAliases: [alias] });
    assert.equal(await isMember(stranger.userId), false);

    // Poussé par l'annuaire, actif : il entre au rôle par défaut.
    const alice = await scim.create(as(admin), { userName: mail("alice"), externalId: "entra-1", displayName: "Alice Martin", active: true });
    assert.ok(alice !== "conflict");
    const login = await provisionIdentity(pool, { issuer, subject: "alice", email: mail("alice"), emailVerified: true, ssoAliases: [alias] });
    assert.ok(await isMember(login.userId));
    assert.equal((await owner.query("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2", [org, login.userId])).rows[0].role, "member");
    // E-mail non vérifié : jamais de rattachement.
    const unverified = await provisionIdentity(pool, { issuer, subject: "alice-bis", email: mail("alice"), emailVerified: false, ssoAliases: [alias] });
    assert.equal(unverified.userId, null);

    // Désactivé par l'annuaire : retrait (comme la route SCIM), puis nouvelle connexion SSO : refusée.
    assert.ok(await scim.update(as(admin), alice.id, { ...alice, active: false }));
    await members.remove(as(admin), login.userId!);
    assert.equal(await isMember(login.userId), false);
    const back = await provisionIdentity(pool, { issuer, subject: "alice", email: mail("alice"), emailVerified: true, ssoAliases: [alias] });
    assert.equal(await isMember(back.userId), false);

    // Réactivé : il revient à sa connexion suivante.
    assert.ok(await scim.update(as(admin), alice.id, { ...alice, active: true }));
    const again = await provisionIdentity(pool, { issuer, subject: "alice", email: mail("alice"), emailVerified: true, ssoAliases: [alias] });
    assert.ok(await isMember(again.userId));

    // L'annuaire supprime TOUS les comptes : la clé active garde l'organisation sous l'annuaire.
    await members.remove(as(admin), again.userId!);
    assert.ok(await scim.delete(as(admin), alice.id));
    const orphan = await provisionIdentity(pool, { issuer, subject: "alice", email: mail("alice"), emailVerified: true, ssoAliases: [alias] });
    assert.equal(await isMember(orphan.userId), false);
  });

  it("comptes SCIM : réservés aux administrateurs ; nom unique par organisation ; contraintes", async () => {
    const bob = await scim.create(as(admin), { userName: mail("bob"), externalId: null, displayName: null, active: true });
    assert.ok(bob !== "conflict");
    assert.equal(await scim.create(as(admin), { userName: mail("bob"), externalId: null, displayName: null, active: true }), "conflict");
    // Un membre ne voit ni ne crée rien.
    assert.deepEqual((await scim.list(as(member), null, 1, 100)).items, []);
    await assert.rejects(scim.create(as(member), { userName: mail("pirate"), externalId: null, displayName: null, active: true }));
    // Filtre par userName (insensible à la casse) et externalId.
    assert.equal((await scim.list(as(admin), { attribute: "userName", value: mail("BOB") }, 1, 10)).total, 1);
    // La base refuse une adresse en majuscules ou avec des espaces.
    await assert.rejects(
      withTenant(pool, as(admin), (client) => client.query("INSERT INTO scim_users (organization_id, user_name) VALUES ($1, 'Bob @x.test')", [org])),
      /scim_users_user_name_check/,
    );
  });
});
