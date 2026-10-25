import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { defaultAvatar } from "../agents/profile.js";
import { PostgresAgentStore } from "../agents/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresPromptStore } from "../prompts/store.js";
import { PostgresMemberStore } from "../workspace/members.js";
import { PostgresSharingStore, SharingRuleError } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Droits fins : personnes, groupes, organisation (RLS)", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let sharing: PostgresSharingStore;
  let prompts: PostgresPromptStore;
  let agents: PostgresAgentStore;
  const org = randomUUID();
  const other = randomUUID();
  const [alice, bob, carol, admin, eve] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const as = (userId: string, organizationId = org) => ({ userId, organizationId });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    sharing = new PostgresSharingStore(pool, keyring);
    prompts = new PostgresPromptStore(pool, keyring);
    agents = new PostgresAgentStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    const people = [alice, bob, carol, admin, eve];
    await owner.query("INSERT INTO users (id, email) SELECT id, id || '@t.local' FROM unnest($1::uuid[]) AS id", [people]);
    await owner.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES
         ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'admin'), ($2, $7, 'member')`,
      [org, other, alice, bob, carol, admin, eve],
    );
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob, carol, admin, eve]]);
    await pool.end();
    await owner.end();
  });

  it("prompt : personne en lecture, puis en modification ; jamais de suppression ni de partage par un autre", async () => {
    const prompt = await prompts.create(as(alice), { name: "Clause", content: "Rédige {{clause}}" });
    assert.deepEqual(await prompts.list(as(bob)), []);

    await sharing.setGrants(as(alice), "prompt", prompt.id, [{ principal: { type: "user", id: bob }, permission: "view" }]);
    const seen = (await prompts.list(as(bob)))[0]!;
    assert.equal(seen.id, prompt.id);
    assert.equal(seen.canEdit, false);
    assert.equal(seen.shared, false, "le partage n'est indiqué qu'à l'auteur");
    assert.equal(await prompts.update(as(bob), prompt.id, { name: "x", content: "x" }), null);
    assert.deepEqual(await prompts.list(as(carol)), []);

    await sharing.setGrants(as(alice), "prompt", prompt.id, [{ principal: { type: "user", id: bob }, permission: "edit" }]);
    const edited = await prompts.update(as(bob), prompt.id, { name: "Clause v2", content: "Rédige {{clause}} en français" });
    assert.equal(edited?.content, "Rédige {{clause}} en français");
    assert.equal(edited?.mine, false);
    assert.equal((await prompts.list(as(alice)))[0]!.mine, true, "l'auteur reste l'auteur");
    assert.equal(await prompts.delete(as(bob), prompt.id), false);
    // Un éditeur ne repartage pas : la RLS le refuse même si l'API se trompait.
    await assert.rejects(sharing.setGrants(as(bob), "prompt", prompt.id, [{ principal: { type: "organization" }, permission: "view" }]), (error: unknown) => error instanceof SharingRuleError && error.code === "FORBIDDEN");
    assert.equal((await sharing.grants(as(alice), "prompt", prompt.id)).length, 1);

    // Retrait : plus rien de visible.
    await sharing.setGrants(as(alice), "prompt", prompt.id, []);
    assert.deepEqual(await prompts.list(as(bob)), []);
    await prompts.delete(as(alice), prompt.id);
  });

  it("groupes : gérés par un administrateur ; l'accès suit l'appartenance au groupe", async () => {
    await assert.rejects(sharing.createGroup(as(bob), "Pirates"), (error: unknown) => error instanceof SharingRuleError && error.code === "FORBIDDEN");
    const group = await sharing.createGroup(as(admin), "Juridique");
    await assert.rejects(sharing.updateGroup(as(bob), group.id, { memberIds: [bob] }), (error: unknown) => error instanceof SharingRuleError);
    await sharing.updateGroup(as(admin), group.id, { memberIds: [bob, carol] });
    await assert.rejects(sharing.updateGroup(as(admin), group.id, { memberIds: [eve] }), (error: unknown) => error instanceof SharingRuleError && error.code === "UNKNOWN_PRINCIPAL");
    assert.deepEqual((await sharing.groups(as(alice))).find((item) => item.id === group.id)?.memberIds.sort(), [bob, carol].sort());
    const raw = await withTenant(pool, as(admin), (client) => client.query("SELECT name FROM member_groups WHERE id = $1", [group.id]));
    assert.ok(!JSON.stringify(raw.rows).includes("Juridique"));

    const prompt = await prompts.create(as(alice), { name: "Modèle", content: "Contenu" });
    await sharing.setGrants(as(alice), "prompt", prompt.id, [{ principal: { type: "group", id: group.id }, permission: "view" }]);
    assert.equal((await prompts.list(as(carol))).length, 1);
    await sharing.updateGroup(as(admin), group.id, { memberIds: [bob] });
    assert.deepEqual(await prompts.list(as(carol)), []);
    assert.equal((await prompts.list(as(bob))).length, 1);

    // Groupe supprimé : ses autorisations partent avec lui.
    assert.equal(await sharing.deleteGroup(as(admin), group.id), true);
    assert.deepEqual(await prompts.list(as(bob)), []);
    assert.deepEqual(await sharing.grants(as(alice), "prompt", prompt.id), []);
    await prompts.delete(as(alice), prompt.id);
  });

  it("membre retiré puis réinvité : il ne retrouve aucun des partages d'avant", async () => {
    const dave = randomUUID();
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [dave, `${dave}@t.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, dave]);
    const prompt = await prompts.create(as(alice), { name: "Stratégie", content: "Plan" });
    await sharing.setGrants(as(alice), "prompt", prompt.id, [{ principal: { type: "user", id: dave }, permission: "edit" }]);
    assert.equal((await prompts.list(as(dave))).length, 1);

    await new PostgresMemberStore(pool).remove(as(admin), dave);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [org, dave]);
    assert.deepEqual(await prompts.list(as(dave)), []);
    assert.deepEqual(await sharing.grants(as(alice), "prompt", prompt.id), []);
    await prompts.delete(as(alice), prompt.id);
    await owner.query("DELETE FROM users WHERE id = $1", [dave]);
  });

  it("agent : privé à sa création ; visible par son administrateur ; partagé à l'organisation ; jamais hors d'elle", async () => {
    const agent = await agents.create(as(alice), { name: "Juriste", avatar: defaultAvatar, instructions: "Cite l'article.", provider: "mistral", model: "mistral-small-latest" });
    assert.equal(await agents.get(as(bob), agent.id), null);
    assert.ok(!(await agents.list(as(bob))).some((item) => item.id === agent.id));
    assert.ok(await agents.get(as(admin), agent.id));
    // SQL direct sans autorisation : aucune ligne (la RLS, pas seulement l'API).
    const peek = await withTenant(pool, as(bob), (client) => client.query("SELECT profile_enc FROM agents WHERE id = $1", [agent.id]));
    assert.equal(peek.rowCount, 0);
    // Tâches système (rotation des clés : contexte sans utilisateur) : l'organisation entière.
    const system = await withTenant(pool, { organizationId: org, userId: "" }, (client) => client.query("SELECT 1 FROM agents WHERE id = $1", [agent.id]));
    assert.equal(system.rowCount, 1);

    await sharing.setGrants(as(alice), "agent", agent.id, [
      { principal: { type: "organization" }, permission: "view" },
      { principal: { type: "user", id: bob }, permission: "edit" },
      { principal: { type: "user", id: bob }, permission: "view" },
    ]);
    assert.deepEqual((await sharing.grants(as(alice), "agent", agent.id)).map((grant) => grant.permission).sort(), ["edit", "view"]);
    assert.equal((await agents.get(as(bob), agent.id))?.access, "edit");
    assert.equal((await agents.get(as(carol), agent.id))?.access, "view");
    assert.equal(await agents.get(as(eve, other), agent.id), null);
    await assert.rejects(sharing.setGrants(as(alice), "agent", agent.id, [{ principal: { type: "user", id: eve }, permission: "view" }]), (error: unknown) => error instanceof SharingRuleError && error.code === "UNKNOWN_PRINCIPAL");
    // Un membre sans droit ne s'en donne pas.
    await assert.rejects(sharing.setGrants(as(carol), "agent", agent.id, [{ principal: { type: "user", id: carol }, permission: "edit" }]), (error: unknown) => error instanceof SharingRuleError && error.code === "FORBIDDEN");

    // Agent supprimé : ses autorisations aussi.
    assert.equal(await agents.delete(as(alice), agent.id), true);
    const left = await owner.query("SELECT 1 FROM resource_grants WHERE resource_id = $1", [agent.id]);
    assert.equal(left.rowCount, 0);
  });
});
