import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { defaultAvatar } from "../agents/profile.js";
import { PostgresAgentStore } from "../agents/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresSharingStore } from "../sharing/store.js";
import { PostgresSkillStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Compétences : RLS, partage, lecture à travers un agent, chiffrement", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let skills: PostgresSkillStore;
  let agents: PostgresAgentStore;
  let sharing: PostgresSharingStore;
  const org = randomUUID();
  const other = randomUUID();
  const [alice, bob, carol, eve] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const as = (userId: string, organizationId = org) => ({ userId, organizationId });
  const input = { name: "Note de synthèse", description: "Rédiger une note de synthèse juridique", instructions: "1. Problème. 2. Règles. 3. Analyse. 4. Conclusion.", confidential: false };
  const agentInput = { name: "Juriste", avatar: defaultAvatar, instructions: "Tu es juriste.", provider: "mistral" as const, model: "mistral-small-latest" };

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    const keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    skills = new PostgresSkillStore(pool, keyring);
    agents = new PostgresAgentStore(pool, keyring);
    sharing = new PostgresSharingStore(pool, keyring);
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [org, other]);
    await owner.query("INSERT INTO users (id, email) SELECT id, id || '@t.local' FROM unnest($1::uuid[]) AS id", [[alice, bob, carol, eve]]);
    await owner.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($2, $6, 'member')",
      [org, other, alice, bob, carol, eve],
    );
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[org, other]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob, carol, eve]]);
    await pool.end();
    await owner.end();
  });

  it("privée, puis partagée en lecture, puis en modification (versions) ; jamais confidentielle retirée par un éditeur", async () => {
    const skill = await skills.create(as(alice), { ...input, confidential: true });
    assert.equal(skill.version, 1);
    assert.deepEqual(await skills.list(as(bob)), []);
    const peek = await withTenant(pool, as(bob), (client) => client.query("SELECT 1 FROM skills WHERE id = $1", [skill.id]));
    assert.equal(peek.rowCount, 0);

    await sharing.setGrants(as(alice), "skill", skill.id, [{ principal: { type: "user", id: bob }, permission: "view" }]);
    const seen = (await skills.list(as(bob)))[0]!;
    assert.deepEqual([seen.id, seen.canEdit, seen.mine], [skill.id, false, false]);
    assert.equal(await skills.update(as(bob), skill.id, { ...input, instructions: "piraté" }), null);
    assert.equal(await skills.addFile(as(bob), skill.id, { name: "x.txt", mediaType: "text/plain", size: 1, text: "x" }), null);

    await sharing.setGrants(as(alice), "skill", skill.id, [{ principal: { type: "user", id: bob }, permission: "edit" }]);
    const edited = await skills.update(as(bob), skill.id, { ...input, instructions: "1. Faits. 2. Problème. 3. Règles.", confidential: false });
    assert.equal(edited?.version, 2);
    assert.equal(edited?.confidential, true, "seul l'auteur retire la confidentialité");
    const history = await skills.versions(as(alice), skill.id);
    assert.deepEqual(history.map((item) => [item.version, item.editedBy]), [[2, bob], [1, alice]]);
    // Renommer sans toucher aux instructions : pas de nouvelle version.
    assert.equal((await skills.update(as(alice), skill.id, { ...input, name: "Synthèse", instructions: "1. Faits. 2. Problème. 3. Règles.", confidential: true }))?.version, 2);
    assert.equal(await skills.delete(as(bob), skill.id), false);
    await skills.delete(as(alice), skill.id);
  });

  it("à travers un agent : qui voit l'agent lit ses compétences, sans les voir dans sa bibliothèque ; retiré, plus rien", async () => {
    const skill = await skills.create(as(alice), input);
    const file = await skills.addFile(as(alice), skill.id, { name: "plan.md", mediaType: "text/markdown", size: 20, text: "Modèle de plan" });
    const agent = await agents.create(as(alice), { ...agentInput, skills: [skill.id] });
    assert.deepEqual(agent.skills, [skill.id]);

    // Carole ne voit rien tant que l'agent n'est pas partagé.
    assert.deepEqual(await skills.forAgent(as(carol), agent.id), []);
    await sharing.setGrants(as(alice), "agent", agent.id, [{ principal: { type: "organization" }, permission: "view" }]);
    const catalog = await skills.forAgent(as(carol), agent.id);
    assert.deepEqual(catalog.map((item) => [item.name, item.description]), [[input.name, input.description]]);
    assert.equal((await skills.load(as(carol), agent.id, skill.id))?.instructions, input.instructions);
    assert.equal((await skills.readFile(as(carol), agent.id, skill.id, file!.id))?.text, "Modèle de plan");
    assert.deepEqual(await skills.list(as(carol)), [], "la bibliothèque ne montre que les siennes et celles partagées");
    // Une compétence non confiée à cet agent ne se charge pas par lui.
    const unrelated = await skills.create(as(alice), { ...input, name: "Autre" });
    assert.equal(await skills.load(as(carol), agent.id, unrelated.id), null);

    // Carole ne peut pas confier à son propre agent la compétence d'Alice (la RLS refuse).
    await assert.rejects(agents.create(as(carol), { ...agentInput, skills: [skill.id] }));
    // Autre organisation : rien.
    assert.deepEqual(await skills.forAgent(as(eve, other), agent.id), []);

    // Accès à l'agent retiré : plus de compétence.
    await sharing.setGrants(as(alice), "agent", agent.id, []);
    assert.equal(await skills.load(as(carol), agent.id, skill.id), null);
    await agents.delete(as(alice), agent.id);
    await skills.delete(as(alice), skill.id);
    await skills.delete(as(alice), unrelated.id);
  });

  it("un éditeur de l'agent qui ne voit pas la compétence ne la casse pas en enregistrant", async () => {
    const skill = await skills.create(as(alice), input);
    const agent = await agents.create(as(alice), { ...agentInput, skills: [skill.id] });
    await sharing.setGrants(as(alice), "agent", agent.id, [{ principal: { type: "user", id: bob }, permission: "edit" }]);
    const saved = await agents.update(as(bob), agent.id, { ...agentInput, name: "Juriste v2", skills: [skill.id] });
    assert.deepEqual(saved?.skills, [skill.id]);
    // Retirer, oui (il modifie l'agent) ; remettre, non (il ne voit pas la compétence).
    assert.deepEqual((await agents.update(as(bob), agent.id, { ...agentInput, skills: [] }))?.skills, []);
    await assert.rejects(agents.update(as(bob), agent.id, { ...agentInput, skills: [skill.id] }));
    await agents.delete(as(alice), agent.id);
    await skills.delete(as(alice), skill.id);
  });

  it("chiffrée au repos ; la base refuse du texte en clair ; supprimée avec ses fichiers, versions et autorisations", async () => {
    const skill = await skills.create(as(alice), { ...input, instructions: "Méthode Orion confidentielle" });
    await skills.addFile(as(alice), skill.id, { name: "orion.txt", mediaType: "text/plain", size: 5, text: "Annexe Orion" });
    await sharing.setGrants(as(alice), "skill", skill.id, [{ principal: { type: "organization" }, permission: "view" }]);
    const raw = await owner.query("SELECT s.name, s.instructions, f.content, v.instructions AS history FROM skills s JOIN skill_files f ON f.skill_id = s.id JOIN skill_versions v ON v.skill_id = s.id WHERE s.id = $1", [skill.id]);
    assert.ok(!/Orion|synthèse/i.test(JSON.stringify(raw.rows)));
    await assert.rejects(
      withTenant(pool, as(alice), (client) => client.query("UPDATE skills SET instructions = 'clair' WHERE id = $1", [skill.id])),
      /skills_encrypted_check/,
    );
    assert.equal(await skills.delete(as(alice), skill.id), true);
    const left = await owner.query(
      "SELECT (SELECT count(*) FROM skill_files WHERE skill_id = $1) + (SELECT count(*) FROM skill_versions WHERE skill_id = $1) + (SELECT count(*) FROM resource_grants WHERE resource_id = $1) AS n",
      [skill.id],
    );
    assert.equal(Number(left.rows[0].n), 0);
  });
});
