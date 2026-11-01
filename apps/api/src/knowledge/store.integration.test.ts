import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { defaultAvatar } from "../agents/profile.js";
import { PostgresAgentStore } from "../agents/store.js";
import { PostgresConversationStore } from "../conversations/store.js";
import { LocalKeyEncryptionProvider } from "../crypto/envelope.js";
import { OrganizationKeyring } from "../crypto/keyring.js";
import { withTenant } from "../db/tenant.js";
import { PostgresProjectStore } from "../projects/store.js";
import { PostgresSharingStore } from "../sharing/store.js";
import { makeDocx } from "../attachments/fixtures.js";
import { normalize } from "./search.js";
import { KnowledgeService } from "./service.js";
import { PostgresKnowledgeStore } from "./store.js";

const appUrl = process.env.TEST_DATABASE_URL;
const ownerUrl = process.env.TEST_DATABASE_MIGRATION_URL;

describe("Bases de connaissances : RLS, chiffrement, triggers", { skip: !appUrl || !ownerUrl }, () => {
  let pool: Pool;
  let owner: Pool;
  let keyring: OrganizationKeyring;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const eve = randomUUID();
  const tenant = (userId: string, organizationId = orgA) => ({ userId, organizationId });

  before(async () => {
    pool = new Pool({ connectionString: appUrl });
    owner = new Pool({ connectionString: ownerUrl });
    keyring = new OrganizationKeyring(new LocalKeyEncryptionProvider(randomBytes(32)));
    await owner.query("INSERT INTO organizations (id, name) VALUES ($1, 'A'), ($2, 'B')", [orgA, orgB]);
    for (const id of [alice, bob, eve]) await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@test.local`]);
    await owner.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'member'), ($1, $4, 'member'), ($2, $5, 'member')",
      [orgA, orgB, alice, bob, eve],
    );
  });

  after(async () => {
    await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
    await owner.query("DELETE FROM users WHERE id = ANY($1)", [[alice, bob, eve]]);
    await pool.end();
    await owner.end();
  });

  const agentInput = { name: "Juriste", avatar: defaultAvatar, instructions: "", provider: "mistral" as const, model: "mistral-small-latest" };

  const shareAgent = (agentId: string) =>
    new PostgresSharingStore(pool, keyring).setGrants(tenant(alice), "agent", agentId, [{ principal: { type: "organization" }, permission: "view" }]);

  it("base d'un agent : lisible de qui peut voir l'agent (pas avant son partage), chiffrée, invisible ailleurs", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const agent = await new PostgresAgentStore(pool, keyring).create(tenant(alice), agentInput);
    const base = await knowledge.ensureBase(tenant(alice), { kind: "agent", agentId: agent.id });
    const source = await knowledge.addSource(tenant(alice), base.id, {
      kind: "file",
      name: "salaires-2026.pdf",
      mediaType: "application/pdf",
      bytes: Buffer.from("contenu confidentiel"),
    });
    const vector = normalize(Float32Array.from([0.1, 0.2, 0.3]));
    await knowledge.replaceChunks(tenant(alice), source.id, [{ text: "Le salaire médian est 4200 €.", vector }], "local:fake");

    // Agent privé : ses documents le sont aussi, au niveau de la base de données
    // (avant la bibliothèque, toute l'organisation pouvait les lire).
    assert.equal(await knowledge.load(tenant(bob), base.id), null);
    await shareAgent(agent.id);
    // Partagé : Bob (même organisation) lit la base au travers de l'agent ; Eve (autre organisation), rien.
    const loaded = await knowledge.load(tenant(bob), base.id);
    assert.equal(loaded?.chunks[0]?.text, "Le salaire médian est 4200 €.");
    assert.deepEqual([...loaded!.chunks[0]!.vector!], [...vector]);
    assert.equal(loaded?.sources.get(source.id)?.name, "salaires-2026.pdf");
    assert.equal(await knowledge.load(tenant(eve, orgB), base.id), null);
    assert.equal(await knowledge.getSource(tenant(eve, orgB), source.id), null);

    // Aucun nom, contenu, passage ni vecteur en clair dans la base.
    const raw = await withTenant(owner, tenant(alice), async (client) => {
      const sources = await client.query("SELECT name, content FROM knowledge_sources WHERE id = $1", [source.id]);
      const chunks = await client.query("SELECT content, embedding FROM knowledge_chunks WHERE source_id = $1", [source.id]);
      return JSON.stringify([sources.rows, chunks.rows]);
    });
    assert.ok(!raw.includes("salaires") && !raw.includes("4200") && !raw.includes("confidentiel"));
    // Passages immuables pour l'application ; et même le propriétaire ne peut
    // pas y écrire de texte en clair.
    await assert.rejects(
      withTenant(pool, tenant(alice), (client) =>
        client.query("UPDATE knowledge_chunks SET content = 'en clair' WHERE source_id = $1", [source.id]),
      ),
      /permission denied/,
    );
    await assert.rejects(
      withTenant(owner, tenant(alice), (client) =>
        client.query("UPDATE knowledge_chunks SET content = 'en clair' WHERE source_id = $1", [source.id]),
      ),
      /knowledge_chunks_encrypted_check/,
    );
  });

  it("base de projet privée : la visibilité est imposée par la base, pas par l'application", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const project = await new PostgresProjectStore(pool, keyring).create(tenant(alice), "Apollo");
    const base = await knowledge.ensureBase(tenant(alice), { kind: "project", projectId: project.id });
    const source = await knowledge.addSource(tenant(alice), base.id, { kind: "file", name: "p.txt", mediaType: "text/plain", bytes: Buffer.from("x") });

    assert.equal(await knowledge.load(tenant(bob), base.id), null);
    // Ouvrir une citation : le texte du document, pour son auteur seulement.
    await knowledge.replaceChunks(tenant(alice), source.id, [{ text: "Budget Apollo : 2 M€.", heading: "Budget", page: 3, vector: null }], null);
    assert.deepEqual(await knowledge.sourcePassages(tenant(alice), source.id), { name: "p.txt", passages: [{ text: "Budget Apollo : 2 M€.", heading: "Budget", page: 3 }] });
    assert.equal(await knowledge.sourcePassages(tenant(bob), source.id), null);
    await assert.rejects(knowledge.ensureBase(tenant(bob), { kind: "project", projectId: project.id }), /PROJECT_NOT_FOUND/);
    assert.equal((await knowledge.listSources(tenant(bob), base.id)).length, 0);

    // Bob ne peut pas rattacher une source à la base d'Alice.
    await assert.rejects(
      knowledge.addSource(tenant(bob), base.id, { kind: "file", name: "x", mediaType: null, bytes: Buffer.from("x") }),
      /KNOWLEDGE_BASE_NOT_FOUND/,
    );
  });

  it("file d'imports : identifiants seuls, inaccessible directement au rôle applicatif", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const agent = await new PostgresAgentStore(pool, keyring).create(tenant(alice), agentInput);
    const base = await knowledge.ensureBase(tenant(alice), { kind: "agent", agentId: agent.id });
    const source = await knowledge.addSource(tenant(alice), base.id, { kind: "link", name: "exemple.com", url: "https://exemple.com", mediaType: null, bytes: Buffer.alloc(0) });

    assert.ok((await knowledge.pending()).some((job) => job.sourceId === source.id && job.createdBy === alice));
    await assert.rejects(pool.query("SELECT * FROM knowledge_jobs"), /permission denied/);
    await knowledge.setStatus(tenant(alice), source.id, "error", "link_timeout");
    assert.ok(!(await knowledge.pending()).some((job) => job.sourceId === source.id));
  });

  it("import complet : extraction isolée, passages chiffrés, recherche après déchiffrement", async () => {
    const store = new PostgresKnowledgeStore(pool, keyring);
    const events: string[] = [];
    const service = new KnowledgeService({
      store,
      embeddings: { available: () => [], get: () => null },
      audit: { record: async (_request, event) => void events.push(`${event.eventType}:${event.outcome}`) },
      log: () => ({ error: () => undefined, warn: () => undefined }) as never,
      linksEnabled: false,
    });
    const agent = await new PostgresAgentStore(pool, keyring).create(tenant(alice), agentInput);
    await shareAgent(agent.id);
    const base = await store.ensureBase(tenant(alice), { kind: "agent", agentId: agent.id });
    const source = await store.addSource(tenant(alice), base.id, {
      kind: "file",
      name: "charte.docx",
      mediaType: null,
      bytes: makeDocx(["Charte informatique", "Les mots de passe font au moins 14 caractères."]),
    });
    service.enqueue(tenant(alice), source.id);
    await service.idle();

    assert.equal((await store.getSource(tenant(alice), source.id))?.status, "ready");
    assert.deepEqual(events, ["knowledge.source_ready:success"]);
    const passages = await service.retrieve(tenant(bob), [{ ...base, label: "agent" }], "longueur des mots de passe");
    assert.match(passages[0]?.text ?? "", /14 caractères/);
    assert.equal(passages[0]?.name, "charte.docx");
  });

  it("supprimer l'agent garde sa base (bibliothèque de son auteur) ; les sources citées sont chiffrées avec le message", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const agents = new PostgresAgentStore(pool, keyring);
    const agent = await agents.create(tenant(alice), agentInput);
    await shareAgent(agent.id);
    const base = await knowledge.ensureBase(tenant(alice), { kind: "agent", agentId: agent.id });
    await knowledge.setConfidential(tenant(alice), base.id, true);
    assert.equal((await knowledge.findBase(tenant(bob), { kind: "agent", agentId: agent.id }))?.confidential, true);

    const conversations = new PostgresConversationStore(pool, keyring);
    const conversation = await conversations.create(tenant(alice), undefined, agent.id);
    const sources = [{ n: 1, sourceId: randomUUID(), name: "rapport-rh.pdf", url: null, base: "agent" as const }];
    await conversations.appendExchange(tenant(alice), conversation.id, "Q", "R [1]", { sources });
    assert.deepEqual((await conversations.getMessages(tenant(alice), conversation.id))?.[1]?.sources, sources);
    const raw = await withTenant(owner, tenant(alice), (client) =>
      client.query("SELECT sources FROM messages WHERE conversation_id = $1", [conversation.id]),
    );
    assert.ok(!JSON.stringify(raw.rows).includes("rapport-rh"));

    await agents.delete(tenant(alice), agent.id);
    // Les documents ne disparaissent pas avec l'agent : la base reste à son auteur,
    // et n'est plus lisible au travers de l'agent.
    assert.notEqual(await knowledge.baseRevision(tenant(alice), base.id), null);
    assert.equal(await knowledge.baseRevision(tenant(bob), base.id), null);
    assert.ok((await knowledge.listBases(tenant(alice))).some((item) => item.id === base.id));
    // La conversation reste, avec ses bascules de connaissances par défaut.
    assert.deepEqual((await conversations.get(tenant(alice), conversation.id))?.knowledge, { agent: true, project: true });
  });

  it("bibliothèque : base nommée (chiffrée), dossiers imbriqués sans boucle, documents rangés, dossier supprimé avec son contenu", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const base = (await knowledge.createBase(tenant(alice), "Politiques RH"))!;
    assert.deepEqual([base.name, base.access], ["Politiques RH", "owner"]);
    const raw = await withTenant(owner, tenant(alice), (client) => client.query("SELECT name FROM knowledge_bases WHERE id = $1", [base.id]));
    assert.ok(!JSON.stringify(raw.rows).includes("Politiques"));

    const rh = (await knowledge.createFolder(tenant(alice), base.id, { name: "Contrats", parentId: null }))!;
    const y2026 = (await knowledge.createFolder(tenant(alice), base.id, { name: "2026", parentId: rh.id }))!;
    // Un dossier ne va jamais dans lui-même ni dans un de ses descendants.
    assert.equal(await knowledge.updateFolder(tenant(alice), rh.id, { parentId: y2026.id }), null);
    assert.equal(await knowledge.updateFolder(tenant(alice), rh.id, { parentId: rh.id }), null);
    // Huit niveaux au plus.
    let parent: string | null = null;
    let depthRefused = false;
    for (let level = 0; level < 9; level++) {
      const folder = await knowledge.createFolder(tenant(alice), base.id, { name: `n${level}`, parentId: parent });
      if (!folder) {
        depthRefused = true;
        break;
      }
      parent = folder.id;
    }
    assert.ok(depthRefused);
    // Un dossier d'une autre base n'est jamais parent ni destination.
    const other = (await knowledge.createBase(tenant(alice), "Autre"))!;
    assert.equal(await knowledge.createFolder(tenant(alice), other.id, { name: "x", parentId: rh.id }), null);

    const source = await knowledge.addSource(tenant(alice), base.id, { kind: "file", name: "cdi.txt", mediaType: "text/plain", bytes: Buffer.from("x"), folderId: y2026.id });
    assert.equal(source.folderId, y2026.id);
    const foreignFolder = (await knowledge.createFolder(tenant(alice), other.id, { name: "y", parentId: null }))!;
    assert.equal(await knowledge.moveSource(tenant(alice), source.id, foreignFolder.id), false);
    assert.equal(await knowledge.moveSource(tenant(alice), source.id, rh.id), true);
    assert.deepEqual((await knowledge.listFolders(tenant(alice), base.id)).find((folder) => folder.id === y2026.id)?.name, "2026");

    // Bob ne voit rien d'une base privée, ni ses dossiers.
    assert.equal(await knowledge.getBase(tenant(bob), base.id), null);
    assert.deepEqual(await knowledge.listFolders(tenant(bob), base.id), []);
    assert.equal(await knowledge.createFolder(tenant(bob), base.id, { name: "intrus", parentId: null }), null);

    // Supprimer un dossier supprime ses sous-dossiers et leurs documents.
    assert.equal(await knowledge.deleteFolder(tenant(alice), rh.id), true);
    assert.equal(await knowledge.getSource(tenant(alice), source.id), null);
    assert.equal((await knowledge.listFolders(tenant(alice), base.id)).some((folder) => folder.id === y2026.id), false);
  });

  it("partage d'une base : lecture ou modification ; jamais par un administrateur pour lui-même ; une base privée le reste", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const sharing = new PostgresSharingStore(pool, keyring);
    const admin = randomUUID();
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [admin, `${admin}@test.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [orgA, admin]);
    try {
      const base = (await knowledge.createBase(tenant(alice), "Contrats"))!;
      const source = await knowledge.addSource(tenant(alice), base.id, { kind: "file", name: "nda.txt", mediaType: "text/plain", bytes: Buffer.from("x") });

      // Un administrateur ne lit pas une base privée, et ne peut pas se l'ouvrir.
      assert.equal(await knowledge.getBase(tenant(admin), base.id), null);
      await assert.rejects(sharing.setGrants(tenant(admin), "knowledge_base", base.id, [{ principal: { type: "user", id: admin }, permission: "view" }]), /FORBIDDEN/);
      // Bob non plus ne peut pas partager la base d'Alice.
      await assert.rejects(sharing.setGrants(tenant(bob), "knowledge_base", base.id, [{ principal: { type: "user", id: bob }, permission: "edit" }]), /FORBIDDEN/);

      // Lecture : Bob lit, sans modifier.
      await sharing.setGrants(tenant(alice), "knowledge_base", base.id, [{ principal: { type: "user", id: bob }, permission: "view" }]);
      assert.equal((await knowledge.getBase(tenant(bob), base.id))?.access, "view");
      assert.ok((await knowledge.listBases(tenant(bob))).some((item) => item.id === base.id));
      await assert.rejects(knowledge.addSource(tenant(bob), base.id, { kind: "file", name: "b.txt", mediaType: null, bytes: Buffer.from("x") }));
      assert.equal(await knowledge.deleteSource(tenant(bob), source.id), false);
      assert.equal(await knowledge.renameBase(tenant(bob), base.id, "Piratée"), null);

      // Modification : Bob ajoute un document, mais ne supprime pas la base ni ne la partage.
      await sharing.setGrants(tenant(alice), "knowledge_base", base.id, [{ principal: { type: "user", id: bob }, permission: "edit" }]);
      assert.equal((await knowledge.getBase(tenant(bob), base.id))?.access, "edit");
      await knowledge.addSource(tenant(bob), base.id, { kind: "file", name: "b.txt", mediaType: null, bytes: Buffer.from("x") });
      assert.equal(await knowledge.deleteBase(tenant(bob), base.id), false);
      // Bob ne retire pas les partages : la base de données n'efface rien.
      await sharing.setGrants(tenant(bob), "knowledge_base", base.id, []);
      assert.equal((await sharing.grants(tenant(alice), "knowledge_base", base.id)).length, 1);

      // L'auteur ne change jamais (même en le forçant) : il garde la main sur le partage.
      await withTenant(pool, tenant(bob), (client) => client.query("UPDATE knowledge_bases SET created_by = $2 WHERE id = $1", [base.id, bob]));
      assert.equal((await knowledge.getBase(tenant(alice), base.id))?.access, "owner");

      // Supprimée par son auteur : partages compris.
      assert.equal(await knowledge.deleteBase(tenant(alice), base.id), true);
      const left = await owner.query("SELECT count(*)::int AS n FROM resource_grants WHERE resource_type = 'knowledge_base' AND resource_id = $1", [base.id]);
      assert.equal(left.rows[0].n, 0);
    } finally {
      await owner.query("DELETE FROM organization_members WHERE user_id = $1", [admin]);
      await owner.query("DELETE FROM users WHERE id = $1", [admin]);
    }
  });

  it("rattachements : une base vers un agent exige de pouvoir la modifier ; un projet reste privé ; plusieurs bases dans l'ordre", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const sharing = new PostgresSharingStore(pool, keyring);
    const agents = new PostgresAgentStore(pool, keyring);
    const bobAgent = await agents.create(tenant(bob), { ...agentInput, name: "Assistant de Bob" });
    await sharing.setGrants(tenant(bob), "agent", bobAgent.id, [{ principal: { type: "organization" }, permission: "view" }]);
    const aliceBase = (await knowledge.createBase(tenant(alice), "Notes d'Alice"))!;
    const bobBase = (await knowledge.createBase(tenant(bob), "Procédures"))!;
    await knowledge.addSource(tenant(alice), aliceBase.id, { kind: "file", name: "secret.txt", mediaType: null, bytes: Buffer.from("x") });

    // Bob lit la base d'Alice (partage en lecture) mais ne peut pas la mettre dans son agent :
    // ce serait la rendre lisible de tous les utilisateurs de l'agent.
    await sharing.setGrants(tenant(alice), "knowledge_base", aliceBase.id, [{ principal: { type: "user", id: bob }, permission: "view" }]);
    assert.equal(await knowledge.setBasesFor(tenant(bob), { kind: "agent", agentId: bobAgent.id }, [aliceBase.id]), false);
    assert.deepEqual(await knowledge.basesFor(tenant(bob), { kind: "agent", agentId: bobAgent.id }), []);
    // Alice ne peut pas modifier l'agent de Bob.
    assert.equal(await knowledge.setBasesFor(tenant(alice), { kind: "agent", agentId: bobAgent.id }, [aliceBase.id]), false);

    // Avec le droit de modifier, oui ; plusieurs bases, dans l'ordre choisi.
    await sharing.setGrants(tenant(alice), "knowledge_base", aliceBase.id, [{ principal: { type: "user", id: bob }, permission: "edit" }]);
    assert.equal(await knowledge.setBasesFor(tenant(bob), { kind: "agent", agentId: bobAgent.id }, [bobBase.id, aliceBase.id]), true);
    assert.deepEqual((await knowledge.basesFor(tenant(bob), { kind: "agent", agentId: bobAgent.id })).map((base) => base.id), [bobBase.id, aliceBase.id]);
    // Eve (autre organisation) ne voit rien ; un collègue voit les bases au travers de l'agent.
    const carol = randomUUID();
    await owner.query("INSERT INTO users (id, email) VALUES ($1, $2)", [carol, `${carol}@test.local`]);
    await owner.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [orgA, carol]);
    try {
      assert.deepEqual((await knowledge.basesFor(tenant(carol), { kind: "agent", agentId: bobAgent.id })).map((base) => base.id), [bobBase.id, aliceBase.id]);
      assert.equal((await knowledge.load(tenant(carol), aliceBase.id))?.base.id, aliceBase.id);
      // … sans la voir dans sa bibliothèque (elle ne lui est pas partagée directement).
      assert.equal((await knowledge.listBases(tenant(carol))).some((item) => item.id === aliceBase.id), false);
      // Retirée de l'agent : plus lisible pour elle.
      assert.equal(await knowledge.setBasesFor(tenant(bob), { kind: "agent", agentId: bobAgent.id }, [bobBase.id]), true);
      assert.equal(await knowledge.load(tenant(carol), aliceBase.id), null);
    } finally {
      await owner.query("DELETE FROM organization_members WHERE user_id = $1", [carol]);
      await owner.query("DELETE FROM users WHERE id = $1", [carol]);
    }

    // Projet : privé à son auteur ; seulement des bases qu'il peut lire.
    const project = await new PostgresProjectStore(pool, keyring).create(tenant(bob), "Orion");
    const evesBase = (await knowledge.createBase(tenant(eve, orgB), "Ailleurs"))!;
    assert.equal(await knowledge.setBasesFor(tenant(bob), { kind: "project", projectId: project.id }, [evesBase.id]), false);
    assert.equal(await knowledge.setBasesFor(tenant(bob), { kind: "project", projectId: project.id }, [aliceBase.id, bobBase.id]), true);
    assert.equal((await knowledge.basesFor(tenant(bob), { kind: "project", projectId: project.id })).length, 2);
    assert.deepEqual(await knowledge.basesFor(tenant(alice), { kind: "project", projectId: project.id }), []);
  });
});
