import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAppServer } from "./server.js";
import type {
  ConversationStore,
  ConversationOwner,
} from "./conversations/store.js";

const testUser = {
  userId: "user-test",
  organizationId: "org-test",
  role: "member" as const,
};

function createFakeStore(): ConversationStore {
  const conversations = new Map<
    string,
    { id: string; owner: ConversationOwner; title: string; createdAt: string; updatedAt: string }
  >();
  const messages = new Map<
    string,
    { id: string; role: "user" | "assistant"; content: string; createdAt: string }[]
  >();

  let sequence = 0;

  function owns(owner: ConversationOwner, id: string) {
    const conversation = conversations.get(id);
    return conversation?.owner.userId === owner.userId &&
      conversation.owner.organizationId === owner.organizationId;
  }

  return {
    list: async (owner) =>
      [...conversations.values()]
        .filter((item) =>
          item.owner.userId === owner.userId &&
          item.owner.organizationId === owner.organizationId
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, title, createdAt, updatedAt }) => ({
          id, title, createdAt, updatedAt,
        })),

    create: async (owner, title = "Nouvelle conversation") => {
      const now = new Date().toISOString();
      const conversation = {
        id: crypto.randomUUID(),
        owner: { ...owner },
        title,
        createdAt: now,
        updatedAt: now,
      };
      conversations.set(conversation.id, conversation);
      messages.set(conversation.id, []);
      return {
        id: conversation.id,
        title: conversation.title,
        createdAt: now,
        updatedAt: now,
      };
    },

    getMessages: async (owner, id) => {
      if (!owns(owner, id)) return null;
      return [...(messages.get(id) ?? [])];
    },

    delete: async (owner, id) => {
      if (!owns(owner, id)) return false;
      conversations.delete(id);
      messages.delete(id);
      return true;
    },

    addMessage: async (owner, id, role, content) => {
      if (!owns(owner, id)) return null;
      const message = {
        id: crypto.randomUUID(),
        role,
        content,
        createdAt: new Date().toISOString(),
      };
      messages.get(id)!.push(message);
      const conversation = conversations.get(id)!;
      conversation.updatedAt = message.createdAt;
      if (
        role === "user" &&
        conversation.title === "Nouvelle conversation"
      ) {
        conversation.title = content.slice(0, 80);
      }
      return message;
    },
  };
}

const fakeStore = createFakeStore();

const authenticatedOptions = {
  withDatabase: false,
  authenticate: async () => testUser,
  conversationStore: fakeStore,
};

describe("API HTTP", () => {
  it("renvoie 200 sur GET /health sans authentification", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
    assert.equal(response.headers["cache-control"], undefined);
  });

  it("renvoie 404 sur une route inconnue", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/route-inconnue",
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "Not found" });
  });

  it("refuse une méthode autre que GET sur /health", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/health",
    });

    assert.equal(response.statusCode, 404);
  });

  it("refuse /chat sans authentification", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Bonjour" },
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Unauthorized" });
  });

  it("refuse /auth/me sans authentification", async (t) => {
    const app = createAppServer({ withDatabase: false });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Unauthorized" });
  });

  it("renvoie l'utilisateur authentifié sur /auth/me", async (t) => {
    const app = createAppServer(authenticatedOptions);
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { user: testUser });
  });

  it("rejette un message vide sur POST /chat", async (t) => {
    const app = createAppServer(authenticatedOptions);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "   " },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json().error, "Invalid request");
  });

  it("renvoie une réponse du graphe sur POST /chat", async (t) => {
    const app = createAppServer(authenticatedOptions);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: { message: "Bonjour" },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      response: "Snowfall a reçu ton message : Bonjour",
    });
  });

  it("rejette les champs inconnus sur POST /chat", async (t) => {
    const app = createAppServer(authenticatedOptions);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/chat",
      payload: {
        message: "Bonjour",
        admin: true,
      },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json().error, "Invalid request");
  });

  it("crée une conversation et la retourne", async (t) => {
    const app = createAppServer({
      ...authenticatedOptions,
      conversationStore: createFakeStore(),
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: { title: "Projet Snowfall" },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().conversation.title, "Projet Snowfall");
  });

  it("rejette la création de conversation pour le rôle reader", async (t) => {
    const app = createAppServer({
      withDatabase: false,
      authenticate: async () => ({ ...testUser, role: "reader" as const }),
      conversationStore: createFakeStore(),
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/conversations",
      payload: {},
    });

    assert.equal(response.statusCode, 403);
  });

  it("isole la liste des conversations par utilisateur et organisation", async (t) => {
    const store = createFakeStore();
    const app = createAppServer({ ...authenticatedOptions, conversationStore: store });
    t.after(() => app.close());

    const created = await store.create(testUser, "Privé");
    const otherUser = {
      userId: "autre-utilisateur",
      organizationId: testUser.organizationId,
    };

    assert.equal((await store.list(testUser)).length, 1);
    assert.equal((await store.list(otherUser)).length, 0);
    assert.equal(await store.getMessages(otherUser, created.id), null);
    assert.equal(await store.delete(otherUser, created.id), false);
    assert.equal((await store.list(testUser)).length, 1);
  });

  it("renvoie 404 lorsqu'un utilisateur tente de lire une conversation étrangère", async (t) => {
    const store = createFakeStore();
    const owner = { ...testUser, userId: "proprietaire" };
    const conversation = await store.create(owner, "Confidentiel");

    const app = createAppServer({
      withDatabase: false,
      authenticate: async () => testUser,
      conversationStore: store,
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: `/conversations/${conversation.id}/messages`,
    });

    assert.equal(response.statusCode, 404);
  });

  it("rejette un identifiant de conversation invalide", async (t) => {
    const app = createAppServer({
      ...authenticatedOptions,
      conversationStore: createFakeStore(),
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/conversations/invalide/messages",
    });

    assert.equal(response.statusCode, 400);
  });
});
