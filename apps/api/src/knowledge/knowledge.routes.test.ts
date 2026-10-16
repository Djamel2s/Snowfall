import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { defaultAgentTools } from "../agent/catalog.js";
import type { Agent, AgentInput, AgentStore } from "../agents/store.js";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { ChatRunner } from "../graph/chat-graph.js";
import type { ModelRegistry } from "../llm/registry.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore, createFakeKnowledgeStore } from "../testing/fakes.js";
import { defaultSettings, type OrganizationSettings, type SettingsStore } from "../workspace/settings.js";
import type { Embedder, EmbeddingCatalog, EmbeddingProvider } from "./embeddings.js";
import { normalize, tokenize } from "./search.js";
import type { MalwareScanner } from "../security/antivirus.js";
import type { QueryRewriter } from "./rewrite.js";
import { KnowledgeService } from "./service.js";

const ORIGIN = "http://localhost:5173";
const ORG = "11111111-1111-4111-8111-111111111111";
const alice: AuthenticatedUser = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId: ORG, role: "member" };
const bob: AuthenticatedUser = { userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", organizationId: ORG, role: "member" };
const alien = { kind: "alien", color: "sky", eyes: "classic", accessory: "none" } as const;

function fakeAgents(): AgentStore {
  const agents = new Map<string, Agent>();
  return {
    list: async () => [...agents.values()],
    get: async (_tenant, id) => agents.get(id) ?? null,
    create: async (tenant, input: AgentInput) => {
      const now = new Date().toISOString();
      const agent = { ...input, tools: input.tools ?? defaultAgentTools, id: crypto.randomUUID(), createdBy: tenant.userId, createdAt: now, updatedAt: now };
      agents.set(agent.id, agent);
      return agent;
    },
    update: async (_tenant, id, input) => {
      const existing = agents.get(id);
      if (!existing) return null;
      const agent = { ...existing, ...input, tools: input.tools ?? existing.tools };
      agents.set(id, agent);
      return agent;
    },
    delete: async (_tenant, id) => agents.delete(id),
  };
}

const registry: ModelRegistry = {
  catalog: async () => [
    { id: "mistral", available: true, models: [{ id: "mistral-small-latest", label: "mistral-small" }] },
    { id: "local", available: true, models: [{ id: "llama", label: "llama" }] },
  ],
  isAllowed: async ({ provider, model }) =>
    (provider === "mistral" && model === "mistral-small-latest") || (provider === "local" && model === "llama"),
  providerFor: (selection) => selection?.provider ?? "echo",
  runner: () => async () => ({ content: "ok", model: "fake" }),
};

/** Embeddings déterministes : sac de mots haché sur 64 dimensions. */
function fakeEmbedder(provider: EmbeddingProvider, calls: string[]): Embedder {
  return {
    provider,
    model: "fake",
    id: `${provider}:fake`,
    batchSize: 8,
    embed: async (texts) => {
      calls.push(provider);
      return {
        tokens: texts.length * 10,
        vectors: texts.map((text) => {
          const vector = new Float32Array(64);
          for (const word of tokenize(text)) vector[[...word].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 64, 7)]! += 1;
          return normalize(vector);
        }),
      };
    },
  };
}

function setup(
  options: {
    settings?: Partial<OrganizationSettings>;
    rewriteQuery?: QueryRewriter;
    scanner?: MalwareScanner;
    /** Modèle capable d'appeler des outils (RAG agentique). */
    tools?: boolean;
    runChat?: ChatRunner;
  } = {},
) {
  let current = alice;
  const events: AuditEvent[] = [];
  const calls: Parameters<ChatRunner>[0][] = [];
  const embedCalls: string[] = [];
  let settings: OrganizationSettings = { ...defaultSettings, ...options.settings };
  const recorded: string[] = [];
  const settingsStore: SettingsStore = {
    get: async () => settings,
    update: async (_tenant, next) => (settings = next),
    usage: async () => ({ period: "2026-10-01", total: { inputTokens: 0, outputTokens: 0 }, byProvider: {}, mine: { inputTokens: 0, outputTokens: 0 } }),
    usageByMember: async () => [],
    record: async (_tenant, provider) => {
      recorded.push(provider);
    },
  };
  const embeddings: EmbeddingCatalog = {
    available: () => ["local", "mistral"],
    get: (provider) => (provider === "local" || provider === "mistral" ? fakeEmbedder(provider, embedCalls) : null),
  };
  const audit = { record: async (_request: unknown, event: AuditEvent) => void events.push(event) };
  const knowledge = new KnowledgeService({
    store: createFakeKnowledgeStore(),
    embeddings,
    settings: settingsStore,
    audit,
    log: () => app.log,
    linksEnabled: true,
    fetchTesting: { resolve: () => [{ address: "127.0.0.1", family: 4 }], isAllowedAddress: () => true, anyPort: true },
  });
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    authenticate: async () => current,
    conversationStore: createFakeConversationStore(),
    agents: fakeAgents(),
    models: options.tools ? { ...registry, supportsTools: () => true } : registry,
    settings: settingsStore,
    knowledge,
    embeddingProviders: () => embeddings.available(),
    audit,
    ...(options.rewriteQuery ? { rewriteQuery: options.rewriteQuery } : {}),
    ...(options.scanner ? { scanner: options.scanner } : {}),
    runChat:
      options.runChat ??
      (async (input, runOptions) => {
        calls.push(input);
        runOptions?.onToken?.("ok");
        return { content: "Réponse [1]", model: "fake" };
      }),
  });
  return {
    app,
    knowledge,
    events,
    calls,
    embedCalls,
    recorded,
    setSettings: (next: Partial<OrganizationSettings>) => (settings = { ...settings, ...next }),
    as: (user: AuthenticatedUser) => {
      current = user;
    },
  };
}

const json = (method: "POST" | "PATCH" | "PUT", url: string, payload: unknown) => ({
  method,
  url,
  headers: { origin: ORIGIN },
  payload: payload as Record<string, unknown>,
});
const upload = (url: string, name: string, content: string | Buffer) => ({
  method: "POST" as const,
  url,
  headers: { origin: ORIGIN, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
  payload: Buffer.isBuffer(content) ? content : Buffer.from(content),
});

async function createAgent(app: ReturnType<typeof setup>["app"], provider: "mistral" | "local" = "mistral") {
  const response = await app.inject(
    json("POST", "/agents", { name: "Juriste", avatar: alien, instructions: "", provider, model: provider === "local" ? "llama" : "mistral-small-latest" }),
  );
  return response.json().agent as Agent;
}

/** Réponse SSE : charge utile de l'événement « done ». */
function done(body: string) {
  const event = body.split("\n\n").find((block) => block.startsWith("event: done"));
  return event ? JSON.parse(event.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) : null;
}

describe("Bases de connaissances : routes", () => {
  it("un agent apprend d'un document, le cite, et la source est conservée avec la réponse", async (t) => {
    const { app, knowledge, calls, events } = setup();
    t.after(() => app.close());
    const agent = await createAgent(app);

    const added = await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "politique.md", "# RH\n\nLes congés payés sont de 27 jours ouvrés par an."));
    assert.equal(added.statusCode, 202);
    assert.equal(added.json().source.status, "pending");
    await knowledge.idle();

    const listed = (await app.inject({ method: "GET", url: `/agents/${agent.id}/knowledge` })).json().knowledge;
    assert.equal(listed.sources[0].status, "ready");
    assert.equal(listed.embeddingModel, null);
    assert.ok(events.some((event) => event.eventType === "knowledge.source_ready" && event.outcome === "success"));
    // L'audit ne contient ni le nom ni le contenu du document.
    assert.ok(!JSON.stringify(events).includes("politique") && !JSON.stringify(events).includes("27 jours"));

    const conversation = (await app.inject(json("POST", "/conversations", { agentId: agent.id }))).json().conversation;
    const answer = await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Combien de jours de congés payés ?" }));
    assert.match(calls[0]!.message, /<knowledge>[\s\S]*27 jours ouvrés[\s\S]*<\/knowledge>\n\nCombien/);
    assert.equal(done(answer.body).assistantMessage.sources[0].name, "politique.md");

    const messages = (await app.inject({ method: "GET", url: `/conversations/${conversation.id}/messages` })).json().messages;
    assert.equal(messages[1].sources[0].base, "agent");
  });

  it("une question de suivi est reformulée avec l'historique ; la citation donne section et page", async (t) => {
    const rewrites: { history: number; message: string }[] = [];
    const { app, knowledge, calls, recorded } = setup({
      rewriteQuery: async ({ history, message }) => {
        rewrites.push({ history: history.length, message });
        return { query: "Accès des stagiaires au restaurant d'entreprise", usage: { inputTokens: 40, outputTokens: 8 } };
      },
    });
    t.after(() => app.close());
    const agent = await createAgent(app);
    await app.inject(
      upload(
        `/agents/${agent.id}/knowledge/files`,
        "rh.md",
        "# Politique RH\n\n## Stagiaires\nGratification de 4,35 € de l'heure.\n\nMême accès au restaurant d'entreprise que les salariés.\n\n## Congés\n30 jours par an.",
      ),
    );
    await knowledge.idle();
    const conversation = (await app.inject(json("POST", "/conversations", { agentId: agent.id }))).json().conversation;
    await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Quelle gratification pour un stagiaire ?" }));
    // Première question : rien à reformuler.
    assert.equal(rewrites.length, 0);

    const answer = await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Et ils mangent où ?" }));
    assert.deepEqual(rewrites, [{ history: 2, message: "Et ils mangent où ?" }]);
    assert.match(calls.at(-1)!.message, /section="Politique RH &#62; Stagiaires"[\s\S]*Même accès au restaurant/);
    assert.equal(done(answer.body).assistantMessage.sources[0].section, "Politique RH > Stagiaires");
    // La reformulation consomme le quota du fournisseur de la conversation.
    assert.ok(recorded.includes("mistral"));
  });

  it("RAG agentique : l'agent reçoit l'outil, cherche lui-même, seules les sources citées sont gardées", async (t) => {
    const seen: Parameters<ChatRunner>[0][] = [];
    const { app, knowledge } = setup({
      tools: true,
      // L'agent cherche deux fois, puis ne cite que le second extrait.
      runChat: async (input) => {
        seen.push(input);
        const tool = input.tools!.find((item) => item.name === "search_knowledge")!;
        const signal = new AbortController().signal;
        const first = await tool.execute({ query: "politique de congés" }, { signal });
        const second = await tool.execute({ query: "télétravail jours par semaine" }, { signal });
        assert.match(first.content, /<source id="1"/);
        assert.match(second.content, /<source id="2"[\s\S]*deux jours/);
        return { content: "Deux jours de télétravail par semaine [2].", model: "fake", steps: 2 };
      },
    });
    t.after(() => app.close());
    const agent = await createAgent(app);
    await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "conges.md", "# Congés\n\nTrente jours de congés payés par an."));
    await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "teletravail.md", "# Télétravail\n\nLe télétravail est possible deux jours par semaine."));
    await knowledge.idle();

    const conversation = (await app.inject(json("POST", "/conversations", { agentId: agent.id }))).json().conversation;
    const answer = await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Combien de jours de télétravail ?" }));

    // Aucun extrait injecté d'office : c'est l'agent qui a cherché.
    assert.ok(!seen[0]!.message.includes("<knowledge>"));
    assert.deepEqual(done(answer.body).assistantMessage.sources.map((source: { n: number; name: string }) => [source.n, source.name]), [[2, "teletravail.md"]]);
  });

  it("un membre lit la base d'un agent qu'il n'a pas créé, sans pouvoir la modifier", async (t) => {
    const { app, knowledge, as } = setup();
    t.after(() => app.close());
    const agent = await createAgent(app);
    const source = (await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "a.txt", "texte"))).json().source;
    await knowledge.idle();

    as(bob);
    const view = (await app.inject({ method: "GET", url: `/agents/${agent.id}/knowledge` })).json().knowledge;
    assert.equal(view.canManage, false);
    assert.equal(view.sources.length, 1);
    assert.equal((await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "b.txt", "x"))).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: `/knowledge/sources/${source.id}`, headers: { origin: ORIGIN } })).statusCode, 403);
    assert.equal((await app.inject(json("PATCH", `/agents/${agent.id}/knowledge`, { confidential: true }))).statusCode, 403);
  });

  it("antivirus : un document infecté n'entre jamais dans la base", async (t) => {
    const { app, events, knowledge } = setup({
      scanner: { scan: async (bytes) => (bytes.includes("EICAR") ? { clean: false, signature: "Eicar-Test-Signature" } : { clean: true }) },
    });
    t.after(() => app.close());
    const agent = await createAgent(app);
    const infected = await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "doc.txt", "X5O!P%@AP EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
    assert.equal(infected.statusCode, 422);
    assert.ok(events.some((event) => event.eventType === "security.malware_detected"));
    assert.equal((await knowledge.store.findBase(alice, { kind: "agent", agentId: agent.id })), null);
  });

  it("refuse les formats non pris en charge avec une raison, et trace le refus", async (t) => {
    const { app, events } = setup();
    t.after(() => app.close());
    const agent = await createAgent(app);

    const audio = await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "réunion.mp3", Buffer.from("ID3\x03\x00\x00 son")));
    assert.equal(audio.statusCode, 415);
    assert.equal(audio.json().reason, "audio_video");
    const binary = await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "outil.exe", Buffer.from([0x4d, 0x5a, 0, 0])));
    assert.equal(binary.json().reason, "unsupported");
    assert.equal(events.filter((event) => event.eventType === "knowledge.source_create" && event.outcome === "denied").length, 2);
  });

  it("liens : adresses internes refusées et tracées, liste de domaines, interrupteur d'organisation", async (t) => {
    const { app, events, setSettings } = setup();
    t.after(() => app.close());
    const agent = await createAgent(app);
    const link = (url: string) => app.inject(json("POST", `/agents/${agent.id}/knowledge/links`, { url }));

    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost:3001/health", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd"]) {
      assert.equal((await link(url)).statusCode, 400, url);
    }
    assert.equal(events.filter((event) => event.eventType === "knowledge.link_denied").length, 4);
    assert.ok(!JSON.stringify(events).includes("169.254"));

    setSettings({ linkDomains: ["docs.exemple.com"] });
    assert.equal((await link("https://autre.com/page")).json().reason, "domain_not_allowed");
    setSettings({ linksEnabled: false });
    assert.equal((await link("https://docs.exemple.com/page")).statusCode, 403);
  });

  describe("import d'une page web", () => {
    let server: Server;
    let port = 0;
    before(async () => {
      server = createServer((_request, response) =>
        response.writeHead(200, { "content-type": "text/html" }).end("<title>Charte informatique</title><p>Mots de passe : 14 caractères minimum.</p>"),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });
    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("récupère la page, la nomme d'après son titre et l'indexe", async (t) => {
      const { app, knowledge, calls } = setup();
      t.after(() => app.close());
      const agent = await createAgent(app);
      // DNS simulé : le nom résout vers le serveur de test (seule exception aux contrôles).
      const added = await app.inject(json("POST", `/agents/${agent.id}/knowledge/links`, { url: `http://wiki.exemple.com:${port}/charte` }));
      assert.equal(added.statusCode, 202);
      await knowledge.idle();

      const source = (await app.inject({ method: "GET", url: `/agents/${agent.id}/knowledge` })).json().knowledge.sources[0];
      assert.equal(source.status, "ready");
      assert.equal(source.name, "Charte informatique");
      assert.equal(source.url, `http://wiki.exemple.com:${port}/charte`);

      const conversation = (await app.inject(json("POST", "/conversations", { agentId: agent.id }))).json().conversation;
      await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Longueur minimum des mots de passe ?" }));
      assert.match(calls[0]!.message, /14 caractères/);
    });
  });

  it("projet : base privée, combinée à celle de l'agent, désactivable par conversation", async (t) => {
    const { app, knowledge, calls, as } = setup();
    t.after(() => app.close());
    const agent = await createAgent(app);
    const projectId = crypto.randomUUID();
    await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "agent.txt", "La politique de sécurité impose le chiffrement AES-256."));
    await app.inject(upload(`/projects/${projectId}/knowledge/files`, "projet.txt", "Le projet Apollo chiffre ses sauvegardes."));
    await knowledge.idle();

    const conversation = (await app.inject(json("POST", "/conversations", { agentId: agent.id, projectId }))).json().conversation;
    const ask = () => app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Quel chiffrement ?" }));
    const both = done((await ask()).body).assistantMessage.sources.map((source: { base: string }) => source.base).sort();
    assert.deepEqual(both, ["agent", "project"]);

    await app.inject(json("PATCH", `/conversations/${conversation.id}`, { knowledge: { agent: false } }));
    const projectOnly = done((await ask()).body).assistantMessage.sources.map((source: { base: string }) => source.base);
    assert.deepEqual(projectOnly, ["project"]);

    await app.inject(json("PATCH", `/conversations/${conversation.id}`, { knowledge: { project: false } }));
    await ask();
    assert.ok(!calls.at(-1)!.message.includes("<knowledge>"));

    // La base de projet d'Alice est invisible pour Bob.
    as(bob);
    const hidden = (await app.inject({ method: "GET", url: `/projects/${projectId}/knowledge` })).json().knowledge;
    assert.equal(hidden.id, null);
    assert.equal(hidden.sources.length, 0);
    assert.equal((await app.inject(upload(`/projects/${projectId}/knowledge/files`, "x.txt", "x"))).statusCode, 404);
  });

  it("confidentiel : ni embeddings ni réponse par un modèle hors plateforme", async (t) => {
    const { app, knowledge, calls, embedCalls, events } = setup({ settings: { embeddingProvider: "mistral" } });
    t.after(() => app.close());

    // Un agent sur Mistral ne peut pas avoir de base confidentielle…
    const external = await createAgent(app, "mistral");
    const refused = await app.inject(json("PATCH", `/agents/${external.id}/knowledge`, { confidential: true }));
    assert.equal(refused.json().reason, "agent_requires_local");

    // … un agent local, si ; et il ne peut plus repasser sur Mistral.
    const local = await createAgent(app, "local");
    assert.equal((await app.inject(json("PATCH", `/agents/${local.id}/knowledge`, { confidential: true }))).statusCode, 200);
    const back = await app.inject(
      json("PUT", `/agents/${local.id}`, { name: "Juriste", avatar: alien, instructions: "", provider: "mistral", model: "mistral-small-latest" }),
    );
    assert.equal(back.json().reason, "agent_requires_local");

    await app.inject(upload(`/agents/${local.id}/knowledge/files`, "secret.txt", "Le code du coffre est 4242."));
    await knowledge.idle();
    // Embeddings Mistral choisis par l'organisation, mais jamais pour une base confidentielle.
    assert.deepEqual(embedCalls, []);

    // Base de projet confidentielle + conversation sur Mistral : refus, modèle jamais appelé.
    const projectId = crypto.randomUUID();
    await app.inject(upload(`/projects/${projectId}/knowledge/files`, "p.txt", "Données de santé."));
    await app.inject(json("PATCH", `/projects/${projectId}/knowledge`, { confidential: true }));
    const conversation = (
      await app.inject(json("POST", "/conversations", { projectId, model: { provider: "mistral", model: "mistral-small-latest" } }))
    ).json().conversation;
    const blocked = await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Résume" }));
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().reason, "confidential_requires_local");
    assert.equal(calls.length, 0);
    assert.ok(events.some((event) => event.eventType === "knowledge.confidential_denied"));
  });

  it("embeddings : calculés par le fournisseur de l'organisation et décomptés", async (t) => {
    const { app, knowledge, embedCalls, recorded, calls } = setup({ settings: { embeddingProvider: "local" } });
    t.after(() => app.close());
    const agent = await createAgent(app);
    await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "a.txt", "Le télétravail est autorisé deux jours par semaine."));
    await knowledge.idle();

    const listed = (await app.inject({ method: "GET", url: `/agents/${agent.id}/knowledge` })).json().knowledge;
    assert.equal(listed.sources[0].embeddingModel, "local:fake");
    assert.ok(embedCalls.includes("local") && recorded.includes("local"));

    const conversation = (await app.inject(json("POST", "/conversations", { agentId: agent.id }))).json().conversation;
    await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "télétravail semaine" }));
    assert.match(calls[0]!.message, /deux jours par semaine/);
  });

  it("supprimer une source la retire des réponses ; un import interrompu reprend au démarrage", async (t) => {
    const { app, knowledge, calls } = setup();
    t.after(() => app.close());
    const agent = await createAgent(app);
    const source = (await app.inject(upload(`/agents/${agent.id}/knowledge/files`, "a.txt", "Le badge est rouge."))).json().source;
    await knowledge.idle();

    assert.equal((await app.inject({ method: "DELETE", url: `/knowledge/sources/${source.id}`, headers: { origin: ORIGIN } })).statusCode, 204);
    const conversation = (await app.inject(json("POST", "/conversations", { agentId: agent.id }))).json().conversation;
    await app.inject(json("POST", `/conversations/${conversation.id}/messages`, { content: "Couleur du badge ?" }));
    assert.ok(!calls[0]!.message.includes("rouge"));

    // Source restée « pending » (arrêt brutal) : reprise par recover().
    const base = await knowledge.store.ensureBase(alice, { kind: "agent", agentId: agent.id });
    const orphan = await knowledge.store.addSource(alice, base.id, { kind: "file", name: "b.txt", mediaType: "text/plain", bytes: Buffer.from("Reprise") });
    await knowledge.recover();
    await knowledge.idle();
    assert.equal((await knowledge.store.getSource(alice, orphan.id))?.status, "ready");
  });
});
