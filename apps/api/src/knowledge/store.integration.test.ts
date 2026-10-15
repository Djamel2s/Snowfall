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

  it("base d'agent partagée dans l'organisation, chiffrée au repos, invisible ailleurs", async () => {
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

    // Bob (même organisation) voit la base de l'agent ; Eve (autre organisation), rien.
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
    await assert.rejects(knowledge.ensureBase(tenant(bob), { kind: "project", projectId: project.id }), /PROJECT_NOT_FOUND/);
    assert.equal((await knowledge.listSources(tenant(bob), base.id)).length, 0);

    // Même en forçant user_id à NULL, le trigger recopie la visibilité de la base.
    const userId = await withTenant(pool, tenant(alice), async (client) => {
      await client.query("UPDATE knowledge_sources SET user_id = NULL WHERE id = $1", [source.id]);
      return (await client.query("SELECT user_id FROM knowledge_sources WHERE id = $1", [source.id])).rows[0]?.user_id;
    });
    assert.equal(userId, alice);
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

  it("supprimer l'agent supprime sa base ; les sources citées sont chiffrées avec le message", async () => {
    const knowledge = new PostgresKnowledgeStore(pool, keyring);
    const agents = new PostgresAgentStore(pool, keyring);
    const agent = await agents.create(tenant(alice), agentInput);
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
    assert.equal(await knowledge.baseRevision(tenant(alice), base.id), null);
    // La conversation reste, avec ses bascules de connaissances par défaut.
    assert.deepEqual((await conversations.get(tenant(alice), conversation.id))?.knowledge, { agent: true, project: true });
  });
});
