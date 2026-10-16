import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import type { Agent, AgentInput, AgentStore } from "../agents/store.js";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { createChatRunner, type ChatChunk, type ChatModel, type ChatRequest, type ChatRunner } from "../graph/chat-graph.js";
import type { EmbeddingCatalog } from "../knowledge/embeddings.js";
import { KnowledgeService } from "../knowledge/service.js";
import type { ModelRegistry } from "../llm/registry.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore, createFakeKnowledgeStore } from "../testing/fakes.js";
import { defaultSettings, type OrganizationSettings, type SettingsStore } from "../workspace/settings.js";
import { defaultAgentTools, type ToolId } from "./catalog.js";
import { MemoryRunStore } from "./runs.js";

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
    update: async () => null,
    delete: async (_tenant, id) => agents.delete(id),
  };
}

const registry: ModelRegistry = {
  catalog: async () => [{ id: "mistral", available: true, models: [{ id: "mistral-small-latest", label: "mistral-small" }] }],
  isAllowed: async ({ provider, model }) => provider === "mistral" && model === "mistral-small-latest",
  providerFor: (selection) => selection?.provider ?? "echo",
  supportsTools: () => true,
  runner: () => async () => ({ content: "ok", model: "fake" }),
};

const note = { title: "Code wifi", content: "Le réseau invités est « Snowfall-Guest »." };

/** L'agent demande d'enregistrer une note, puis conclut selon le résultat. */
const notingModel: ChatModel = {
  id: "scripted",
  supportsTools: true,
  async *stream(request): AsyncIterable<ChatChunk> {
    const result = request.turns?.at(-1);
    if (result?.role === "tool") {
      yield { type: "token", text: result.content.startsWith("Note") ? "C'est noté." : "Je n'enregistre rien." };
      return;
    }
    yield { type: "token", text: "Je l'enregistre. " };
    yield { type: "tool_call", call: { id: "call-1", name: "save_to_knowledge", arguments: note } };
  },
};

/** Ce que deux instances de l'API partagent : la base (runs, points de reprise, conversations). */
function sharedDatabase() {
  return {
    runs: new MemoryRunStore(),
    checkpoints: new MemorySaver(),
    conversations: createFakeConversationStore(),
    knowledge: createFakeKnowledgeStore(),
    agents: fakeAgents(),
    events: [] as AuditEvent[],
  };
}

type Database = ReturnType<typeof sharedDatabase>;

/** Une instance de l'API, branchée sur la base partagée. */
async function instance(
  db: Database,
  options: { settings?: Partial<OrganizationSettings>; runChat?: ChatRunner; model?: ChatModel; timing?: Parameters<typeof createAppServer>[0]["runTiming"] } = {},
) {
  let current = alice;
  const settings: OrganizationSettings = { ...defaultSettings, ...options.settings };
  const settingsStore: SettingsStore = {
    get: async () => settings,
    update: async (_tenant, next) => next,
    usage: async () => ({ period: "2026-10-01", total: { inputTokens: 0, outputTokens: 0 }, byProvider: {}, mine: { inputTokens: 0, outputTokens: 0 } }),
    usageByMember: async () => [],
    record: async () => undefined,
  };
  const audit = { record: async (_request: unknown, event: AuditEvent) => void db.events.push(event) };
  const embeddings: EmbeddingCatalog = { available: () => [], get: () => null };
  const knowledge = new KnowledgeService({ store: db.knowledge, embeddings, settings: settingsStore, audit, log: () => app.log, linksEnabled: false });
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    authenticate: async () => current,
    conversationStore: db.conversations,
    agents: db.agents,
    models: registry,
    settings: settingsStore,
    knowledge,
    audit,
    runs: db.runs,
    checkpointer: () => db.checkpoints,
    ...(options.timing ? { runTiming: options.timing } : {}),
    runChat: options.runChat ?? createChatRunner(options.model ?? notingModel),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const post = (url: string, payload: unknown, signal?: AbortSignal) =>
    fetch(`${base}${url}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(payload), ...(signal ? { signal } : {}) });
  const get = (url: string) => fetch(`${base}${url}`);
  // Arrêt : connexions keep-alive du client de test fermées (sinon elles retiennent le serveur).
  const close = async () => {
    app.server.closeAllConnections();
    await app.close();
  };
  return { app, close, knowledge, post, get, as: (user: AuthenticatedUser) => (current = user) };
}

type Instance = Awaited<ReturnType<typeof instance>>;

async function agentConversation(api: Instance, tools: ToolId[] = ["search_knowledge", "save_to_knowledge"]) {
  const agent = ((await (await api.post("/agents", { name: "Assistant", avatar: alien, instructions: "", provider: "mistral", model: "mistral-small-latest", tools })).json()) as { agent: Agent }).agent;
  const conversation = ((await (await api.post("/conversations", { agentId: agent.id })).json()) as { conversation: { id: string } }).conversation;
  return { agent, conversationId: conversation.id };
}

type Event = { event: string; data: Record<string, unknown> };

/** Lit un flux SSE jusqu'à sa fin. */
async function events(response: Response, until?: (event: Event) => boolean) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const seen: Event[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      seen.push({ event, data: JSON.parse(data) as Record<string, unknown> });
      if (until?.(seen.at(-1)!)) {
        await reader.cancel();
        return seen;
      }
    }
  }
  return seen;
}

const names = (seen: Event[]) => seen.map((item) => (item.event === "step" ? `step:${String(item.data.status)}` : item.event));
const until = async (check: () => Promise<boolean>, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("délai dépassé");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("Exécution durable : runs", () => {
  it("validation : le run se met en pause (serveur libéré), se retrouve à la reconnexion, puis reprend", async (t) => {
    const db = sharedDatabase();
    const api = await instance(db);
    t.after(() => api.close());
    const { agent, conversationId } = await agentConversation(api);

    const first = await events(await api.post(`/conversations/${conversationId}/messages`, { content: "Retiens le wifi invités." }));
    assert.deepEqual(names(first), ["token", "step:running", "approval", "paused"]);
    const approval = first.find((item) => item.event === "approval")!.data;
    assert.equal(approval.detail, note.content);

    // Reconnexion (onglet rouvert) : question, texte, étape et validation en attente.
    const snapshot = ((await (await api.get(`/conversations/${conversationId}/run`)).json()) as { run: Record<string, unknown> }).run;
    assert.equal(snapshot.status, "waiting");
    assert.equal(snapshot.question, "Retiens le wifi invités.");
    assert.equal(snapshot.text, "Je l'enregistre. ");
    assert.deepEqual((snapshot.approvals as { id: string }[]).map((item) => item.id), [approval.id]);
    // Une seule réponse à la fois par conversation.
    assert.equal((await api.post(`/conversations/${conversationId}/messages`, { content: "Autre chose" })).status, 409);

    const resumed = await events(await api.post(`/conversations/${conversationId}/approvals/${String(approval.id)}`, { approved: true }));
    assert.deepEqual(names(resumed), ["step:running", "step:done", "token", "done"]);
    const done = resumed.at(-1)!.data as { assistantMessage: { content: string }; userMessage: { content: string } };
    assert.equal(done.assistantMessage.content, "Je l'enregistre. \n\nC'est noté.");
    assert.equal(done.userMessage.content, "Retiens le wifi invités.");

    await api.knowledge.idle();
    const base = await db.knowledge.findBase(alice, { kind: "agent", agentId: agent.id });
    assert.deepEqual((await db.knowledge.listSources(alice, base!.id)).map((source) => source.name), ["code-wifi.md"]);
    // Run terminé : effacé, points de reprise compris.
    assert.equal(((await (await api.get(`/conversations/${conversationId}/run`)).json()) as { run: unknown }).run, null);
    assert.equal(await db.checkpoints.getTuple({ configurable: { thread_id: (snapshot.id as string) } }), undefined);
    assert.ok(!JSON.stringify(db.events).includes("Snowfall-Guest"));
  });

  it("la validation est reprise par une autre instance (redémarrage entre les deux)", async (t) => {
    const db = sharedDatabase();
    const first = await instance(db);
    const { conversationId } = await agentConversation(first);
    const paused = await events(await first.post(`/conversations/${conversationId}/messages`, { content: "Retiens ça." }));
    const approval = paused.find((item) => item.event === "approval")!.data;
    await first.close();

    const second = await instance(db);
    t.after(() => second.close());
    const resumed = await events(await second.post(`/conversations/${conversationId}/approvals/${String(approval.id)}`, { approved: false }));
    assert.equal((resumed.at(-1)!.data as { assistantMessage: { content: string } }).assistantMessage.content, "Je l'enregistre. \n\nJe n'enregistre rien.");
    assert.ok(db.events.some((event) => event.eventType === "tool.approval" && event.details?.decision === "denied"));
  });

  it("un autre utilisateur ne peut ni voir ni trancher la demande", async (t) => {
    const db = sharedDatabase();
    const api = await instance(db);
    t.after(() => api.close());
    const { conversationId } = await agentConversation(api);
    const approval = (await events(await api.post(`/conversations/${conversationId}/messages`, { content: "Retiens ça." }))).find((item) => item.event === "approval")!.data;

    api.as(bob);
    const denied = await api.post(`/conversations/${conversationId}/approvals/${String(approval.id)}`, { approved: true });
    assert.equal(denied.status, 404);
    await denied.body?.cancel();
    assert.equal(((await (await api.get(`/conversations/${conversationId}/run`)).json()) as { run: unknown }).run, null);
    api.as(alice);
    assert.equal(((await (await api.get(`/conversations/${conversationId}/run`)).json()) as { run: { status: string } }).run.status, "waiting");
  });

  it("fermer l'onglet n'arrête pas la réponse : elle est enregistrée quand même", async (t) => {
    const db = sharedDatabase();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: ChatModel = {
      id: "slow",
      supportsTools: true,
      async *stream() {
        yield { type: "token", text: "Début… " };
        await gate;
        yield { type: "token", text: "fin." };
      },
    };
    const api = await instance(db, { model: slow });
    t.after(() => api.close());
    const { conversationId } = await agentConversation(api, []);

    const controller = new AbortController();
    const response = await api.post(`/conversations/${conversationId}/messages`, { content: "Longue réponse" }, controller.signal);
    await events(response, (item) => item.event === "token");
    controller.abort();
    release();

    await until(async () => (await db.conversations.getMessages(alice, conversationId))!.length === 2);
    assert.equal((await db.conversations.getMessages(alice, conversationId))![1]!.content, "Début… fin.");
  });

  it("arrêter : la réponse partielle est gardée et le run effacé", async (t) => {
    const db = sharedDatabase();
    const hanging: ChatModel = {
      id: "hanging",
      supportsTools: true,
      async *stream(_request: ChatRequest, signal?: AbortSignal) {
        yield { type: "token", text: "Une partie" };
        await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    };
    const api = await instance(db, { model: hanging });
    t.after(() => api.close());
    const { conversationId } = await agentConversation(api, []);
    const response = await api.post(`/conversations/${conversationId}/messages`, { content: "Question" });
    const reading = events(response);
    await until(async () => (await db.runs.active(alice, conversationId))?.progress !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await api.post(`/conversations/${conversationId}/run/cancel`, {})).status, 202);

    const seen = await reading;
    assert.equal((seen.at(-1)!.data as { assistantMessage: { content: string } }).assistantMessage.content, "Une partie");
    assert.equal(await db.runs.active(alice, conversationId), null);
  });

  it("panne pendant une étape : une autre instance reprend au dernier point, sans relancer ce qui était fait", async (t) => {
    const db = sharedDatabase();
    let lookups = 0;
    let crash = true;
    // Étape 1 : l'agent cherche (outil de lecture compté) ; étape 2 : l'instance tombe en pleine réponse.
    const model: ChatModel = {
      id: "crashy",
      supportsTools: true,
      async *stream(request: ChatRequest, signal?: AbortSignal) {
        if (request.turns?.at(-1)?.role !== "tool") {
          yield { type: "tool_call", call: { id: "s1", name: "lookup", arguments: {} } };
          return;
        }
        if (crash) {
          yield { type: "token", text: "partiel " };
          await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("shutdown"))));
        }
        yield { type: "token", text: "Réponse complète." };
      },
    };
    const { z } = await import("zod");
    const { defineTool } = await import("./tools.js");
    const lookup = defineTool({
      name: "lookup",
      description: "Lit.",
      parameters: z.object({}).strict(),
      access: "read",
      execute: async () => {
        lookups++;
        return { content: "trouvé" };
      },
    });
    const runner = createChatRunner(model);
    const runChat: ChatRunner = (input, options) => runner({ ...input, tools: [lookup] }, options);
    const timing = { leaseMs: 150, renewMs: 50, recoveryMs: 40, approvalTtlSeconds: 3600 };

    const first = await instance(db, { runChat, timing });
    const { conversationId } = await agentConversation(first, []);
    const response = await first.post(`/conversations/${conversationId}/messages`, { content: "Cherche" });
    await events(response, (item) => item.event === "token");
    // Arrêt brutal de l'instance : rien n'est effacé, le bail va expirer.
    await first.close();
    assert.equal((await db.runs.active(alice, conversationId))?.status, "running");

    crash = false;
    const second = await instance(db, { runChat, timing });
    t.after(() => second.close());
    await until(async () => (await db.conversations.getMessages(alice, conversationId))!.length === 2);
    assert.equal((await db.conversations.getMessages(alice, conversationId))![1]!.content, "Réponse complète.");
    // L'outil de l'étape 1 était enregistré : il n'a pas été relancé.
    assert.equal(lookups, 1);
    assert.equal(await db.runs.active(alice, conversationId), null);
  });

  it("validation restée sans réponse trop longtemps : refusée, la réponse se termine", async (t) => {
    const db = sharedDatabase();
    const api = await instance(db, { timing: { leaseMs: 1_000, renewMs: 200, recoveryMs: 40, approvalTtlSeconds: 0 } });
    t.after(() => api.close());
    const { conversationId } = await agentConversation(api);
    await events(await api.post(`/conversations/${conversationId}/messages`, { content: "Retiens ça." }));

    await until(async () => (await db.conversations.getMessages(alice, conversationId))!.length === 2);
    assert.equal((await db.conversations.getMessages(alice, conversationId))![1]!.content, "Je l'enregistre. \n\nJe n'enregistre rien.");
    assert.ok(db.events.some((event) => event.eventType === "tool.approval" && event.details?.decision === "expired"));
  });

  it("l'outil d'écriture n'est proposé que si l'organisation, l'agent et les droits le permettent", async (t) => {
    const offered: string[][] = [];
    const runChat: ChatRunner = async (input) => {
      offered.push((input.tools ?? []).map((tool) => tool.name));
      return { content: "ok", model: "fake" };
    };
    const ask = async (api: Instance, conversationId: string) => (await api.post(`/conversations/${conversationId}/messages`, { content: "Bonjour" })).text();

    const allowed = await instance(sharedDatabase(), { runChat });
    t.after(() => allowed.close());
    const writer = await agentConversation(allowed);
    const reader = await agentConversation(allowed, ["search_knowledge"]);
    await ask(allowed, writer.conversationId);
    await ask(allowed, reader.conversationId);
    // Bob utilise l'agent d'Alice : il ne peut pas enrichir sa base.
    allowed.as(bob);
    const bobs = ((await (await allowed.post("/conversations", { agentId: writer.agent.id })).json()) as { conversation: { id: string } }).conversation;
    await ask(allowed, bobs.id);

    const restricted = await instance(sharedDatabase(), { runChat, settings: { tools: ["search_knowledge"] } });
    t.after(() => restricted.close());
    const blocked = await agentConversation(restricted);
    await ask(restricted, blocked.conversationId);

    assert.deepEqual(offered, [["save_to_knowledge"], [], [], []]);
    // L'organisation l'a désactivé : l'agent est même enregistré sans lui.
    assert.deepEqual(blocked.agent.tools, ["search_knowledge"]);
  });
});
