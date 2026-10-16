import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomBytes } from "node:crypto";
import { cookieNames, createAppServer, type AppDependencies } from "./server.js";
import type { AuditEvent, AuditLog } from "./audit/audit.js";
import { LoginTransactionCodec, type OidcClient } from "./auth/oidc.js";
import type { SessionStore } from "./auth/session-store.js";
import { createFakeConversationStore } from "./testing/fakes.js";

const ORIGIN = "http://localhost:5173";

const testUser = {
  userId: "user-test",
  organizationId: "org-test",
  role: "member" as const,
};

function createFakeStore() {
  return createFakeConversationStore();
}

function parseSse(body: string) {
  return body
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? (JSON.parse(data) as any) : undefined };
    });
}

function createAuditRecorder() {
  const events: AuditEvent[] = [];
  const audit: AuditLog = { record: async (_request, event) => { events.push(event); } };
  return { events, audit };
}

function server(overrides: Partial<AppDependencies> = {}) {
  const app = createAppServer({
    appOrigin: ORIGIN,
    withDatabase: false,
    logger: false,
    conversationStore: createFakeStore(),
    ...overrides,
  });
  return app;
}

const signedIn = { authenticate: async () => testUser };

describe("API HTTP : surface publique et refus par défaut", () => {
  it("renvoie 200 sur GET /health sans authentification", async (t) => {
    const app = server();
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/health" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  });

  it("renvoie 404 sur une route inconnue", async (t) => {
    const app = server();
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/route-inconnue" });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "Not found" });
  });

  it("refuse toutes les routes protégées sans session", async (t) => {
    const app = server();
    t.after(() => app.close());
    const id = crypto.randomUUID();

    for (const [method, url] of [
      ["GET", "/auth/me"],
      ["GET", "/conversations"],
      ["POST", "/conversations"],
      ["GET", `/conversations/${id}/messages`],
      ["POST", `/conversations/${id}/messages`],
      ["DELETE", `/conversations/${id}`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { origin: ORIGIN },
        ...(method === "POST" ? { payload: {} } : {}),
      });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }
  });

  it("ajoute les en-têtes de sécurité", async (t) => {
    const app = server();
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/health" });

    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.ok(response.headers["content-security-policy"]);
  });
});

describe("API HTTP : protection CSRF", () => {
  it("refuse une requête modifiante sans en-tête Origin", async (t) => {
    const { events, audit } = createAuditRecorder();
    const app = server({ ...signedIn, audit });
    t.after(() => app.close());

    const response = await app.inject({ method: "POST", url: "/conversations", payload: {} });

    assert.equal(response.statusCode, 403);
    assert.equal(events[0]?.eventType, "security.csrf_rejected");
  });

  it("refuse une requête modifiante d'une autre origine", async (t) => {
    const app = server(signedIn);
    t.after(() => app.close());

    const response = await app.inject({
      method: "DELETE",
      url: `/conversations/${crypto.randomUUID()}`,
      headers: { origin: "https://attaquant.example" },
    });

    assert.equal(response.statusCode, 403);
  });
});

describe("API HTTP : conversations", () => {
  it("renvoie l'utilisateur et le profil sur /auth/me", async (t) => {
    const app = server({
      authenticate: async () => ({ ...testUser, profile: { name: "Alice" } }),
    });
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/auth/me" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { user: testUser, profile: { name: "Alice" } });
    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("crée une conversation et trace l'événement", async (t) => {
    const { events, audit } = createAuditRecorder();
    const app = server({ ...signedIn, audit });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { origin: ORIGIN },
      payload: { title: "Projet Snowfall" },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().conversation.title, "Projet Snowfall");
    assert.equal(events[0]?.eventType, "conversation.create");
  });

  it("rejette les champs inattendus", async (t) => {
    const app = server(signedIn);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { origin: ORIGIN },
      payload: { title: "x", organizationId: "autre" },
    });

    assert.equal(response.statusCode, 400);
  });

  it("rejette l'écriture pour le rôle reader et la trace", async (t) => {
    const { events, audit } = createAuditRecorder();
    const app = server({
      authenticate: async () => ({ ...testUser, role: "reader" as const }),
      audit,
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { origin: ORIGIN },
      payload: {},
    });

    assert.equal(response.statusCode, 403);
    assert.equal(events[0]?.eventType, "authorization.write");
    assert.equal(events[0]?.outcome, "denied");
  });

  it("renvoie 404 sur une conversation étrangère et trace la tentative", async (t) => {
    const store = createFakeStore();
    const conversation = await store.create({ ...testUser, userId: "proprietaire" }, "Confidentiel");
    const { events, audit } = createAuditRecorder();
    const app = server({ ...signedIn, conversationStore: store, audit });
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: `/conversations/${conversation.id}/messages`,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(events[0]?.eventType, "conversation.access");
    assert.equal(events[0]?.targetId, conversation.id);
  });

  it("rejette un identifiant de conversation invalide", async (t) => {
    const app = server(signedIn);
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/conversations/invalide/messages" });

    assert.equal(response.statusCode, 400);
  });

  it("diffuse la réponse en SSE puis enregistre l'échange", async (t) => {
    const store = createFakeStore();
    const conversation = await store.create(testUser);
    const { events: audit, audit: auditLog } = createAuditRecorder();
    const app = server({
      ...signedIn,
      conversationStore: store,
      audit: auditLog,
      runChat: async (_input, options) => {
        options?.onToken?.("Bon");
        options?.onToken?.("jour");
        return { content: "Bonjour", model: "fake", usage: { inputTokens: 5, outputTokens: 2 } };
      },
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversation.id}/messages`,
      headers: { origin: ORIGIN },
      payload: { content: "Salut" },
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /^text\/event-stream/);
    assert.equal(response.headers["cache-control"], "no-store");

    const events = parseSse(response.body);
    assert.deepEqual(
      events.filter((event) => event.event === "token").map((event) => event.data.text),
      ["Bon", "jour"],
    );
    const done = events.at(-1);
    assert.equal(done?.event, "done");
    assert.equal(done?.data.assistantMessage.content, "Bonjour");

    const saved = await store.getMessages(testUser, conversation.id);
    assert.deepEqual(saved?.map((message) => message.content), ["Salut", "Bonjour"]);

    const created = audit.find((event) => event.eventType === "message.create");
    assert.deepEqual(created?.details, {
      agentId: "",
      model: "fake",
      inputTokens: 5,
      outputTokens: 2,
      attachments: 0,
      edited: false,
      passages: 0,
      partial: false,
      steps: 0,
    });
  });

  it("signale l'échec du modèle et n'enregistre rien", async (t) => {
    const store = createFakeStore();
    const conversation = await store.create(testUser);
    const app = server({
      ...signedIn,
      conversationStore: store,
      runChat: async (_input, options) => {
        options?.onToken?.("début");
        throw new Error("boom");
      },
    });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: `/conversations/${conversation.id}/messages`,
      headers: { origin: ORIGIN },
      payload: { content: "Bonjour" },
    });

    const last = parseSse(response.body).at(-1);
    assert.equal(last?.event, "error");
    assert.deepEqual(last?.data, { error: "Assistant unavailable" });
    assert.ok(!response.body.includes("boom"), "le détail de l'erreur ne fuit pas");
    assert.deepEqual(await store.getMessages(testUser, conversation.id), []);
  });

  it("limite les messages par utilisateur, quelle que soit l'IP", async (t) => {
    const store = createFakeStore();
    const conversation = await store.create(testUser);
    const app = server({ ...signedIn, conversationStore: store, runChat: async () => ({ content: "ok", model: "fake" }) });
    t.after(() => app.close());

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const response = await app.inject({
        method: "POST",
        url: `/conversations/${conversation.id}/messages`,
        headers: { origin: ORIGIN },
        remoteAddress: `10.0.0.${i + 1}`,
        payload: { content: `message ${i}` },
      });
      statuses.push(response.statusCode);
    }

    assert.equal(statuses.filter((status) => status === 200).length, 20);
    assert.equal(statuses.at(-1), 429);
  });
});

describe("API HTTP : connexion BFF", () => {
  const masterKey = randomBytes(32);
  const names = cookieNames(false);

  function createLoginFixture(options: { knownIdentity?: boolean; failCallback?: boolean } = {}) {
    const sessions = new Map<string, { userId: string; idToken: string }>();
    const { events, audit } = createAuditRecorder();

    const oidc: OidcClient = {
      startLogin: async () => ({
        authorizationUrl: "http://idp.test/authorize?request_uri=urn:par:1",
        transaction: { state: "s", nonce: "n", codeVerifier: "v", createdAt: Date.now() },
      }),
      completeLogin: async (url, transaction) => {
        if (options.failCallback || url.searchParams.get("state") !== transaction.state) {
          throw new Error("state mismatch");
        }
        return {
          subject: "kc-sub",
          tokens: { refreshToken: "rt", idToken: "it" },
          profile: { name: "Alice" },
          emailVerified: true,
          organizations: [],
        };
      },
      refresh: async () => null,
      logoutUrl: async (idToken) => `http://idp.test/logout?id_token_hint=${idToken}`,
    };

    const store: SessionStore = {
      create: async ({ userId, tokens }) => {
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, { userId, idToken: tokens.idToken });
        return token;
      },
      resolve: async () => ({ status: "missing" }),
      revoke: async (token) => {
        const session = token ? sessions.get(token) : undefined;
        if (!session || !token) return null;
        sessions.delete(token);
        return session;
      },
      revokeIdpSession: async () => [],
      purgeExpired: async () => 0,
    };

    const app = server({
      audit,
      login: {
        issuer: "http://idp.test",
        oidc,
        sessions: store,
        transactions: new LoginTransactionCodec(masterKey),
        directory: {
          findUserId: async () => (options.knownIdentity === false ? null : "user-1"),
          memberships: async () => [],
        },
      },
    });

    return { app, sessions, events };
  }

  type InjectedCookie = {
    name: string;
    value: string;
    httpOnly?: boolean;
    sameSite?: string;
    path?: string;
  };

  function cookieFrom(response: { cookies: InjectedCookie[] }, name: string) {
    return response.cookies.find((item) => item.name === name);
  }

  it("redirige vers l'IdP avec une transaction chiffrée en cookie", async (t) => {
    const { app } = createLoginFixture();
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/auth/login" });

    assert.equal(response.statusCode, 302);
    assert.match(response.headers.location ?? "", /^http:\/\/idp\.test\/authorize/);
    const tx = response.cookies.find((item) => item.name === names.login);
    assert.ok(tx?.httpOnly);
    assert.equal(tx?.sameSite, "Lax");
    assert.ok(!tx?.value.includes("\"state\""), "la transaction ne doit pas être lisible");
  });

  it("ouvre une session HttpOnly SameSite=Strict après un callback valide", async (t) => {
    const { app, sessions, events } = createLoginFixture();
    t.after(() => app.close());

    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const tx = cookieFrom(login, names.login)!;

    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=s",
      cookies: { [names.login]: tx.value },
    });

    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, `${ORIGIN}/`);
    const session = cookieFrom(callback, names.session);
    assert.ok(session?.httpOnly);
    assert.equal(session?.sameSite, "Strict");
    assert.equal(session?.path, "/");
    assert.equal(sessions.size, 1);
    assert.equal(events.at(-1)?.eventType, "auth.login");
    assert.equal(events.at(-1)?.outcome, "success");
  });

  it("refuse un callback sans transaction (CSRF de connexion)", async (t) => {
    const { app, sessions, events } = createLoginFixture();
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/auth/callback?code=abc&state=s" });

    assert.equal(response.statusCode, 302);
    assert.match(response.headers.location ?? "", /auth_error=access_denied/);
    assert.equal(sessions.size, 0);
    assert.equal(events[0]?.outcome, "failure");
  });

  it("refuse une transaction falsifiée", async (t) => {
    const { app, sessions } = createLoginFixture();
    t.after(() => app.close());
    const forged = new LoginTransactionCodec(randomBytes(32)).encode({
      state: "s", nonce: "n", codeVerifier: "v", createdAt: Date.now(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=s",
      cookies: { [names.login]: forged },
    });

    assert.match(response.headers.location ?? "", /auth_error/);
    assert.equal(sessions.size, 0);
  });

  it("refuse un state ne correspondant pas à la transaction", async (t) => {
    const { app, sessions } = createLoginFixture();
    t.after(() => app.close());
    const login = await app.inject({ method: "GET", url: "/auth/login" });

    const response = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=autre",
      cookies: { [names.login]: cookieFrom(login, names.login)!.value },
    });

    assert.match(response.headers.location ?? "", /auth_error/);
    assert.equal(sessions.size, 0);
  });

  it("refuse une identité Keycloak non rattachée à un utilisateur", async (t) => {
    const { app, sessions, events } = createLoginFixture({ knownIdentity: false });
    t.after(() => app.close());
    const login = await app.inject({ method: "GET", url: "/auth/login" });

    const response = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=s",
      cookies: { [names.login]: cookieFrom(login, names.login)!.value },
    });

    assert.match(response.headers.location ?? "", /auth_error/);
    assert.equal(sessions.size, 0);
    assert.equal(events.at(-1)?.outcome, "denied");
  });

  it("révoque la session et renvoie l'URL de déconnexion IdP", async (t) => {
    const { app, sessions } = createLoginFixture();
    t.after(() => app.close());
    const login = await app.inject({ method: "GET", url: "/auth/login" });
    const callback = await app.inject({
      method: "GET",
      url: "/auth/callback?code=abc&state=s",
      cookies: { [names.login]: cookieFrom(login, names.login)!.value },
    });
    const session = cookieFrom(callback, names.session)!.value;

    const refused = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [names.session]: session },
    });
    assert.equal(refused.statusCode, 403, "logout sans Origin refusé (CSRF)");
    assert.equal(sessions.size, 1);

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: ORIGIN },
      cookies: { [names.session]: session },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().logoutUrl, "http://idp.test/logout?id_token_hint=it");
    assert.equal(sessions.size, 0);
  });
});
