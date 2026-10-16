import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppServer } from "../server.js";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { ConversationStore } from "../conversations/store.js";
import type { ChatRunner } from "../graph/chat-graph.js";
import type { ModelRegistry } from "../llm/registry.js";
import type { ModelSelection } from "../llm/types.js";
import { defaultAvatar, isSafeImageDataUrl, readAvatar } from "./profile.js";
import { defaultAgentTools } from "../agent/catalog.js";
import type { Agent, AgentInput, AgentStore } from "./store.js";
import { createFakeConversationStore } from "../testing/fakes.js";

const ORIGIN = "http://localhost:5173";
const ORG = "11111111-1111-4111-8111-111111111111";
const alice: AuthenticatedUser = { userId: "alice", organizationId: ORG, role: "member" };
const bob: AuthenticatedUser = { userId: "bob", organizationId: ORG, role: "member" };
const admin: AuthenticatedUser = { userId: "carol", organizationId: ORG, role: "admin" };

const alien = { kind: "alien", color: "mint", eyes: "classic", accessory: "antenna" } as const;
const validAgent = {
  name: "Juriste",
  avatar: alien,
  instructions: "Réponds comme un juriste.",
  provider: "mistral",
  model: "mistral-small-latest",
};

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

function fakeRegistry(calls: { selection?: ModelSelection; instructions?: string }[] = []): ModelRegistry {
  return {
    catalog: async () => [
      { id: "mistral", available: true, models: [{ id: "mistral-small-latest", label: "mistral-small" }] },
      { id: "openai", available: false, models: [] },
      { id: "anthropic", available: false, models: [] },
      { id: "local", available: false, models: [] },
    ],
    isAllowed: async ({ provider, model }) => provider === "mistral" && model === "mistral-small-latest",
    providerFor: (selection) => selection?.provider ?? "echo",
    runner: (selection): ChatRunner => async (input) => {
      calls.push({
        ...(selection ? { selection } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
      });
      return { content: "ok", model: selection ? `${selection.provider}:${selection.model}` : "default" };
    },
  };
}

function fakeConversations(): ConversationStore {
  return createFakeConversationStore();
}

function setup(options: { user?: AuthenticatedUser; agents?: AgentStore; calls?: Parameters<typeof fakeRegistry>[0] } = {}) {
  let current = options.user ?? alice;
  const events: AuditEvent[] = [];
  const agents = options.agents ?? fakeAgents();
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    authenticate: async () => current,
    conversationStore: fakeConversations(),
    agents,
    models: fakeRegistry(options.calls),
    audit: { record: async (_request, event) => { events.push(event); } },
  });
  return { app, events, agents, as: (user: AuthenticatedUser) => { current = user; } };
}

const post = (url: string, payload: unknown) => ({
  method: "POST" as const,
  url,
  headers: { origin: ORIGIN },
  payload: payload as Record<string, unknown>,
});

describe("Agents", () => {
  it("expose le catalogue des fournisseurs", async (t) => {
    const { app } = setup();
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/models" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().providers[0].id, "mistral");
  });

  it("crée un agent et trace l'événement sans son contenu", async (t) => {
    const { app, events } = setup();
    t.after(() => app.close());

    const response = await app.inject(post("/agents", validAgent));

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().agent.name, "Juriste");
    assert.equal(response.json().agent.canEdit, true);
    assert.equal(events[0]?.eventType, "agent.create");
    assert.ok(!JSON.stringify(events).includes("juriste"));
  });

  it("refuse un modèle hors liste blanche", async (t) => {
    const { app } = setup();
    t.after(() => app.close());

    for (const selection of [
      { provider: "mistral", model: "modele-inconnu" },
      { provider: "openai", model: "gpt-x" },
      { provider: "inconnu", model: "x" },
    ]) {
      const response = await app.inject(post("/agents", { ...validAgent, ...selection }));
      assert.equal(response.statusCode, 400, JSON.stringify(selection));
    }
  });

  it("refuse un avatar SVG, falsifié ou trop lourd", async (t) => {
    const { app } = setup();
    t.after(() => app.close());

    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`;
    const fakePng = `data:image/png;base64,${Buffer.from("<script>").toString("base64")}`;
    const huge = `data:image/png;base64,${Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200_000),
    ]).toString("base64")}`;

    for (const data of [svg, fakePng, huge]) {
      const response = await app.inject(post("/agents", { ...validAgent, avatar: { kind: "image", data } }));
      assert.equal(response.statusCode, 400);
    }
  });

  it("refuse les champs inattendus et les avatars inconnus ou retirés", async (t) => {
    const { app } = setup();
    t.after(() => app.close());

    for (const payload of [
      { ...validAgent, createdBy: "pirate" },
      { ...validAgent, avatar: { ...alien, color: "red" } },
      { ...validAgent, avatar: { kind: "alien", color: "mint" } },
      { ...validAgent, avatar: { kind: "mochi", color: "sakura", face: "happy", accessory: "leaf" } },
    ]) {
      const response = await app.inject(post("/agents", payload));
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
  });

  it("interdit la création au rôle reader", async (t) => {
    const { app } = setup({ user: { ...alice, role: "reader" } });
    t.after(() => app.close());

    const response = await app.inject(post("/agents", validAgent));

    assert.equal(response.statusCode, 403);
  });

  it("seuls l'auteur et les admins modifient ou suppriment un agent", async (t) => {
    const { app, as } = setup();
    t.after(() => app.close());
    const created = (await app.inject(post("/agents", validAgent))).json().agent;
    const update = { ...post(`/agents/${created.id}`, { ...validAgent, name: "Renommé" }), method: "PUT" as const };

    as(bob);
    const list = (await app.inject({ method: "GET", url: "/agents" })).json().agents;
    assert.equal(list[0].canEdit, false);
    assert.equal((await app.inject(update)).statusCode, 403);
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/agents/${created.id}`, headers: { origin: ORIGIN } })).statusCode,
      403,
    );

    as(admin);
    assert.equal((await app.inject(update)).statusCode, 200);
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/agents/${created.id}`, headers: { origin: ORIGIN } })).statusCode,
      204,
    );
  });

  it("une conversation avec agent utilise son modèle et ses instructions", async (t) => {
    const calls: { selection?: ModelSelection; instructions?: string }[] = [];
    const { app } = setup({ calls });
    t.after(() => app.close());

    const agent = (await app.inject(post("/agents", validAgent))).json().agent;
    const conversation = (await app.inject(post("/conversations", { agentId: agent.id }))).json().conversation;
    assert.equal(conversation.agentId, agent.id);

    const response = await app.inject(post(`/conversations/${conversation.id}/messages`, { content: "Bonjour" }));

    assert.match(response.body, /event: done/);
    assert.deepEqual(calls[0], {
      selection: { provider: "mistral", model: "mistral-small-latest" },
      instructions: "Réponds comme un juriste.",
    });
  });

  it("une conversation sans agent utilise le modèle choisi", async (t) => {
    const calls: { selection?: ModelSelection; instructions?: string }[] = [];
    const { app } = setup({ calls });
    t.after(() => app.close());

    const model = { provider: "mistral", model: "mistral-small-latest" };
    const conversation = (await app.inject(post("/conversations", { model }))).json().conversation;
    assert.deepEqual(conversation.model, model);
    assert.equal(conversation.agentId, null);

    await app.inject(post(`/conversations/${conversation.id}/messages`, { content: "Bonjour" }));
    assert.deepEqual(calls[0], { selection: model });
  });

  it("refuse un modèle hors liste blanche ou combiné à un agent", async (t) => {
    const { app } = setup();
    t.after(() => app.close());
    const agent = (await app.inject(post("/agents", validAgent))).json().agent;

    for (const payload of [
      { model: { provider: "mistral", model: "modele-inconnu" } },
      { model: { provider: "openai", model: "gpt-x" } },
      { model: { provider: "mistral", model: "mistral-small-latest", extra: 1 } },
      { agentId: agent.id, model: { provider: "mistral", model: "mistral-small-latest" } },
    ]) {
      const response = await app.inject(post("/conversations", payload));
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
  });

  it("change d'agent ou de modèle tant que la conversation est vide, plus ensuite", async (t) => {
    const calls: { selection?: ModelSelection; instructions?: string }[] = [];
    const { app, events } = setup({ calls });
    t.after(() => app.close());
    const agent = (await app.inject(post("/agents", validAgent))).json().agent;
    const conversation = (await app.inject(post("/conversations", {}))).json().conversation;
    const patch = (payload: unknown) => ({ ...post(`/conversations/${conversation.id}`, payload), method: "PATCH" as const });

    const toAgent = await app.inject(patch({ agentId: agent.id }));
    assert.equal(toAgent.statusCode, 200);
    assert.equal(toAgent.json().conversation.agentId, agent.id);

    const model = { provider: "mistral", model: "mistral-small-latest" };
    const toModel = await app.inject(patch({ model }));
    assert.equal(toModel.json().conversation.agentId, null);
    assert.deepEqual(toModel.json().conversation.model, model);
    assert.equal(events.at(-1)?.details?.model, "mistral:mistral-small-latest");

    assert.equal((await app.inject(patch({ model: { provider: "mistral", model: "inconnu" } }))).statusCode, 400);
    assert.equal((await app.inject(patch({ agentId: crypto.randomUUID() }))).statusCode, 400);

    await app.inject(post(`/conversations/${conversation.id}/messages`, { content: "Bonjour" }));
    assert.deepEqual(calls[0], { selection: model });

    const locked = await app.inject(patch({ agentId: agent.id }));
    assert.equal(locked.statusCode, 409);
    // Renommer reste possible.
    assert.equal((await app.inject(patch({ title: "Renommée" }))).statusCode, 200);
  });

  it("le catalogue indique le modèle par défaut", async (t) => {
    const { app } = setup();
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/models" });
    assert.equal(response.json().defaultModel, null);
  });

  it("refuse une conversation liée à un agent inconnu", async (t) => {
    const conversations = fakeConversations();
    conversations.create = async () => {
      throw new Error("AGENT_NOT_FOUND");
    };
    const strict = createAppServer({
      appOrigin: ORIGIN,
      logger: false,
      authenticate: async () => alice,
      conversationStore: conversations,
      models: fakeRegistry(),
    });
    t.after(() => strict.close());

    const response = await strict.inject(post("/conversations", { agentId: crypto.randomUUID() }));
    assert.equal(response.statusCode, 400);
  });
});

describe("readAvatar", () => {
  it("remplace un ancien format par l'avatar par défaut et garde un avatar valide", () => {
    assert.deepEqual(readAvatar({ kind: "mochi", color: "sakura", face: "happy", accessory: "leaf" }), defaultAvatar);
    assert.deepEqual(readAvatar(alien), alien);
  });
});

describe("isSafeImageDataUrl", () => {
  const encode = (type: string, bytes: number[]) =>
    `data:image/${type};base64,${Buffer.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64")}`;

  it("accepte PNG, JPEG et WebP authentiques", () => {
    assert.ok(isSafeImageDataUrl(encode("png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.ok(isSafeImageDataUrl(encode("jpeg", [0xff, 0xd8, 0xff, 0xe0])));
    assert.ok(isSafeImageDataUrl(encode("webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")])));
  });

  it("refuse un type annoncé qui ne correspond pas au contenu", () => {
    assert.ok(!isSafeImageDataUrl(encode("png", [0xff, 0xd8, 0xff, 0xe0])));
    assert.ok(!isSafeImageDataUrl(encode("gif", [0x47, 0x49, 0x46, 0x38])));
    assert.ok(!isSafeImageDataUrl("javascript:alert(1)"));
  });
});
