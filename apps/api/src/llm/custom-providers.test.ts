import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { validateMcpUrl } from "../mcp/client.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import type { MemberStore } from "../workspace/members.js";
import { defaultSettings, type OrganizationSettings, type SettingsStore, type UsageSummary } from "../workspace/settings.js";
import { guardedFetch, MAX_CUSTOM_PROVIDERS, MemoryCustomProviderStore, splitCustomModel, type CustomEndpoint } from "./custom-providers.js";
import { MemoryModelKeyStore } from "./keys.js";
import { ProviderRegistry, ProviderUnavailableError, type ProviderAdapter } from "./registry.js";
import type { ProviderId, ProviderSettings } from "./types.js";

// Fournisseurs personnalisés : un serveur compatible OpenAI ajouté par un administrateur.
// Ce qui compte : seulement pour son organisation, jamais vers le réseau interne,
// jamais la clé en retour ni dans l'audit, et facturé à l'organisation.

const ORIGIN = "http://localhost:5173";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "55555555-5555-4555-8555-555555555555";
const member: AuthenticatedUser = { userId: "22222222-2222-4222-8222-222222222222", organizationId: ORG, role: "member" };
const admin: AuthenticatedUser = { ...member, userId: "33333333-3333-4333-8333-333333333333", role: "admin" };
const outsider: AuthenticatedUser = { userId: "66666666-6666-4666-8666-666666666666", organizationId: OTHER_ORG, role: "admin" };

const SECRET = "sk-router-secret-9876";
const URL_A = "https://router.example.com/api/v1";

/** Faux serveurs : notent l'adresse et la clé de chaque appel ; une clé contenant « bad » est refusée. */
function fakeProviders() {
  const used: { provider: ProviderId; apiKey: string; baseUrl?: string | undefined; model: string; fetch: boolean }[] = [];
  const adapter = (id: ProviderId, settings: ProviderSettings): ProviderAdapter => ({
    list: async () => {
      if (settings.apiKey.includes("bad")) throw new Error("401");
      return [{ id: "llama-70b", label: "llama-70b" }];
    },
    create: (model) => ({
      id: `${id}:${model}`,
      supportsTools: settings.tools === true,
      async *stream() {
        used.push({ provider: id, apiKey: settings.apiKey, baseUrl: settings.baseUrl, model, fetch: typeof settings.fetch === "function" });
        yield { type: "token" as const, text: "ok" };
        yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
      },
    }),
  });
  const customFetch: typeof fetch = async () => new Response("{}");
  const registry = new ProviderRegistry(
    { mistral: { apiKey: "platform-key-0000", maxOutputTokens: 100, timeoutMs: 1000 } },
    { defaultSelection: { provider: "mistral", model: "llama-70b" }, defaults: { maxOutputTokens: 100, timeoutMs: 1000 }, adapter, customFetch },
  );
  return { registry, used };
}

const endpoint = (id: string, apiKey?: string): CustomEndpoint => ({ id, name: "Routeur", baseUrl: URL_A, apiKey });

const usage = (): UsageSummary => ({ period: "2026-11-01", total: { inputTokens: 0, outputTokens: 0 }, byProvider: {}, mine: { inputTokens: 0, outputTokens: 0 } });

function setup(initial: Partial<OrganizationSettings> = {}) {
  const events: AuditEvent[] = [];
  const conversations = createFakeConversationStore();
  const providers = new MemoryCustomProviderStore();
  const { registry, used } = fakeProviders();
  let settings: OrganizationSettings = { ...defaultSettings, ...initial };
  const recorded: { provider: string; tokens: number }[] = [];
  const store: SettingsStore = {
    get: async () => settings,
    update: async (_tenant, next) => (settings = next),
    usage: async () => usage(),
    usageByMember: async () => [],
    record: async (_tenant, provider, totals) => void recorded.push({ provider, tokens: totals.inputTokens + totals.outputTokens }),
  };
  let current: AuthenticatedUser = member;
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    conversationStore: conversations,
    authenticate: async () => current,
    audit: { record: async (_request, event) => void events.push(event) },
    models: registry,
    modelKeys: new MemoryModelKeyStore(),
    modelProviders: providers,
    settings: store,
    members: {} as MemberStore,
  });
  const as = (user: AuthenticatedUser) => (current = user);
  const add = (user: AuthenticatedUser, payload: Record<string, unknown>) => {
    as(user);
    return app.inject({ method: "POST", url: "/organization/model-providers", headers: { origin: ORIGIN }, payload });
  };
  const view = async (user: AuthenticatedUser) => {
    as(user);
    return (await app.inject({ method: "GET", url: "/me/model-keys" })).json() as { custom: Record<string, unknown>[] };
  };
  const ask = async (user: AuthenticatedUser, model: { provider: string; model: string }) => {
    as(user);
    const created = await app.inject({ method: "POST", url: "/conversations", headers: { origin: ORIGIN }, payload: { model } });
    if (created.statusCode !== 201) return created;
    const { id } = (created.json() as { conversation: { id: string } }).conversation;
    return app.inject({ method: "POST", url: `/conversations/${id}/messages`, headers: { origin: ORIGIN }, payload: { content: "Bonjour" } });
  };
  return { app, events, providers, used, recorded, as, add, view, ask, setSettings: (next: Partial<OrganizationSettings>) => (settings = { ...settings, ...next }) };
}

describe("Fournisseurs personnalisés : registre", () => {
  it("publie « <id>/<modèle> » sous « custom », libellé « <nom> · <modèle> », servi par l'adresse et la clé du fournisseur", async () => {
    const { registry, used } = fakeProviders();
    const view = registry.withKeys({}, [endpoint("a1", SECRET)]);
    const custom = (await view.catalog()).find((item) => item.id === "custom");
    assert.deepEqual(custom, { id: "custom", available: true, models: [{ id: "a1/llama-70b", label: "Routeur · llama-70b" }] });
    assert.equal(await view.isAllowed({ provider: "custom", model: "a1/llama-70b" }), true);
    assert.equal(view.supportsTools?.({ provider: "custom", model: "a1/llama-70b" }), true);
    // Payé par l'organisation : compté dans ses quotas et budgets.
    assert.equal(view.keySource?.("custom"), "organization");

    await view.runner({ provider: "custom", model: "a1/llama-70b" })({ message: "a" });
    // Le fetch protégé (anti-SSRF) sert chaque appel.
    assert.deepEqual(used, [{ provider: "custom", apiKey: SECRET, baseUrl: URL_A, model: "llama-70b", fetch: true }]);
  });

  it("le fournisseur d'une autre organisation n'existe pas pour moi : ni catalogue, ni appel", async () => {
    const { registry, used } = fakeProviders();
    const mine = registry.withKeys({}, [endpoint("a1", SECRET)]);
    const theirs = registry.withKeys({}, []);
    assert.equal((await theirs.catalog()).find((item) => item.id === "custom")?.available, false);
    assert.equal(await theirs.isAllowed({ provider: "custom", model: "a1/llama-70b" }), false);
    await assert.rejects(() => theirs.runner({ provider: "custom", model: "a1/llama-70b" })({ message: "x" }), ProviderUnavailableError);
    // Identifiant inconnu ou mal formé : indisponible, jamais un autre serveur.
    await assert.rejects(() => mine.runner({ provider: "custom", model: "zz/llama-70b" })({ message: "x" }), ProviderUnavailableError);
    await assert.rejects(() => mine.runner({ provider: "custom", model: "llama-70b" })({ message: "x" }), ProviderUnavailableError);
    assert.equal(used.length, 0);
  });

  it("clé changée : le cache est rangé par adresse et empreinte de clé, la nouvelle clé sert aussitôt", async () => {
    const { registry, used } = fakeProviders();
    await registry.withKeys({}, [endpoint("a1", "sk-old-key-1111")]).runner({ provider: "custom", model: "a1/llama-70b" })({ message: "a" });
    await registry.withKeys({}, [endpoint("a1", "sk-new-key-2222")]).runner({ provider: "custom", model: "a1/llama-70b" })({ message: "b" });
    assert.deepEqual(used.map((call) => call.apiKey), ["sk-old-key-1111", "sk-new-key-2222"]);
  });

  it("checkEndpoint : un serveur qui refuse la clé est rejeté", async () => {
    const { registry } = fakeProviders();
    assert.equal(await registry.checkEndpoint({ baseUrl: URL_A, apiKey: SECRET }), 1);
    await assert.rejects(() => registry.checkEndpoint({ baseUrl: URL_A, apiKey: "sk-bad-key-0000" }), /ENDPOINT_REJECTED/);
  });

  it("splitCustomModel : « <id>/<modèle> », le modèle peut contenir des « / »", () => {
    assert.deepEqual(splitCustomModel("a1/meta-llama/Llama-3"), { endpointId: "a1", model: "meta-llama/Llama-3" });
    assert.equal(splitCustomModel("llama"), null);
    assert.equal(splitCustomModel("/llama"), null);
    assert.equal(splitCustomModel("a1/"), null);
  });
});

describe("Fournisseurs personnalisés : jamais vers le réseau interne", () => {
  it("guardedFetch : HTTPS seulement, adresse vérifiée avant chaque appel, aucune redirection suivie", async () => {
    const checked: string[] = [];
    const calls: RequestInit[] = [];
    const base: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      return new Response("{}");
    };
    const blockInternal = async (hostname: string) => {
      checked.push(hostname);
      if (hostname === "rebound.example.com") throw new Error("MCP_INVALID_URL");
    };
    const guarded = guardedFetch(blockInternal, base);

    await guarded("https://router.example.com/api/v1/models", { method: "GET" });
    assert.deepEqual(checked, ["router.example.com"]);
    assert.equal(calls[0]?.redirect, "error");
    // Le nom pointe désormais vers une adresse interne : refusé avant tout envoi.
    await assert.rejects(() => guarded("https://rebound.example.com/v1/chat/completions"), /INVALID_URL/);
    await assert.rejects(() => guarded("http://router.example.com/v1/models"), /INVALID_URL/);
    assert.equal(calls.length, 1);
  });

  it("adresses refusées à l'ajout : HTTP, réseau interne, identifiants, paramètres, port inhabituel", async () => {
    const { add, providers } = setup();
    for (const baseUrl of [
      "http://router.example.com/v1",
      "https://127.0.0.1/v1",
      "https://10.0.0.8/v1",
      "https://[::1]/v1",
      "https://localhost/v1",
      "https://postgres/v1",
      "https://metadata.google.internal/v1",
      "https://user:pass@router.example.com/v1",
      "https://router.example.com/v1?key=abc",
      "https://router.example.com:8443/v1",
      "file:///etc/passwd",
    ]) {
      const response = await add(admin, { name: "Routeur", baseUrl, apiKey: SECRET });
      assert.equal(response.statusCode, 400, baseUrl);
      assert.equal(response.json().reason, "invalid_endpoint", baseUrl);
    }
    assert.deepEqual(await providers.list(admin), []);
  });

  it("validateMcpUrl (celle des routes) refuse aussi un nom sans domaine", () => {
    assert.throws(() => validateMcpUrl("https://snowfall-postgres/v1"));
  });
});

describe("Fournisseurs personnalisés : routes", () => {
  it("un membre ne peut pas ajouter ni retirer un fournisseur (refus tracé)", async () => {
    const { add, app, as, events, providers } = setup();
    const response = await add(member, { name: "Routeur", baseUrl: URL_A, apiKey: SECRET });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(await providers.list(member), []);
    const id = await providers.create(admin, { name: "Routeur", baseUrl: URL_A, apiKey: SECRET });
    as(member);
    const removed = await app.inject({ method: "DELETE", url: `/organization/model-providers/${id}`, headers: { origin: ORIGIN } });
    assert.equal(removed.statusCode, 403);
    assert.equal((await providers.list(admin)).length, 1);
    assert.ok(events.some((event) => event.outcome === "denied"));
  });

  it("ajout : serveur vérifié, clé jamais renvoyée ni journalisée, adresse visible des seuls administrateurs", async () => {
    const { add, view, events } = setup();
    const response = await add(admin, { name: "Routeur", baseUrl: `${URL_A}/`, apiKey: SECRET });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes(SECRET));
    const [item] = response.json().custom as { id: string; name: string; models: number; baseUrl: string; hint: string }[];
    // Barre oblique finale retirée ; indice de 4 caractères pour l'administrateur.
    assert.deepEqual({ name: item?.name, models: item?.models, baseUrl: item?.baseUrl, hint: item?.hint }, { name: "Routeur", models: 1, baseUrl: URL_A, hint: "9876" });

    const seen = (await view(member)).custom[0];
    assert.deepEqual(Object.keys(seen ?? {}).sort(), ["allowed", "id", "models", "name"]);

    const audit = events.find((event) => event.eventType === "model_provider.create" && event.outcome !== "failure");
    assert.deepEqual(audit?.details, { name: "Routeur", host: "router.example.com", models: 1, key: true });
    assert.ok(!JSON.stringify(events).includes(SECRET) && !JSON.stringify(events).includes("9876"));
  });

  it("serveur qui refuse la clé : rien n'est gardé, échec tracé sans la clé", async () => {
    const { add, events, providers } = setup();
    const response = await add(admin, { name: "Routeur", baseUrl: URL_A, apiKey: "sk-bad-key-0000" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().reason, "endpoint_rejected");
    assert.deepEqual(await providers.list(admin), []);
    assert.ok(events.some((event) => event.eventType === "model_provider.create" && event.outcome === "failure"));
    assert.ok(!JSON.stringify(events).includes("sk-bad-key-0000"));
  });

  it("fournisseur « custom » retiré de la liste blanche : ajout refusé, modèles refusés", async () => {
    const { add, ask, providers, setSettings } = setup();
    const id = await providers.create(admin, { name: "Routeur", baseUrl: URL_A, apiKey: SECRET });
    setSettings({ allowedProviders: defaultSettings.allowedProviders.filter((provider) => provider !== "custom") });
    const response = await add(admin, { name: "Autre", baseUrl: URL_A, apiKey: SECRET });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().reason, "provider_not_allowed");
    const answer = await ask(member, { provider: "custom", model: `${id}/llama-70b` });
    assert.notEqual(answer.statusCode, 200);
  });

  it(`au plus ${MAX_CUSTOM_PROVIDERS} fournisseurs par organisation`, async () => {
    const { add, providers } = setup();
    for (let index = 0; index < MAX_CUSTOM_PROVIDERS; index++) await providers.create(admin, { name: `R${index}`, baseUrl: URL_A });
    const response = await add(admin, { name: "Un de trop", baseUrl: URL_A, apiKey: SECRET });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, "too_many_providers");
  });

  it("un membre répond avec un modèle personnalisé : servi par le fournisseur, compté pour l'organisation", async () => {
    const { add, ask, used, recorded } = setup();
    const created = await add(admin, { name: "Routeur", baseUrl: URL_A, apiKey: SECRET });
    const id = (created.json().custom as { id: string }[])[0]!.id;
    const answer = await ask(member, { provider: "custom", model: `${id}/llama-70b` });
    assert.equal(answer.statusCode, 200);
    assert.deepEqual(used.map((call) => [call.provider, call.apiKey, call.baseUrl, call.model]), [["custom", SECRET, URL_A, "llama-70b"]]);
    assert.deepEqual(recorded, [{ provider: "custom", tokens: 15 }]);
  });

  it("une autre organisation ne voit ni n'utilise ce fournisseur", async () => {
    const { add, ask, view, used } = setup();
    const created = await add(admin, { name: "Routeur", baseUrl: URL_A, apiKey: SECRET });
    const id = (created.json().custom as { id: string }[])[0]!.id;
    assert.deepEqual((await view(outsider)).custom, []);
    const answer = await ask(outsider, { provider: "custom", model: `${id}/llama-70b` });
    assert.notEqual(answer.statusCode, 200);
    assert.equal(used.length, 0);
  });

  it("retrait par un administrateur : effet immédiat, le modèle n'est plus servi", async () => {
    const { add, app, as, ask, events, used } = setup();
    const created = await add(admin, { name: "Routeur", baseUrl: URL_A, apiKey: SECRET });
    const id = (created.json().custom as { id: string }[])[0]!.id;
    await ask(member, { provider: "custom", model: `${id}/llama-70b` });
    as(admin);
    const removed = await app.inject({ method: "DELETE", url: `/organization/model-providers/${id}`, headers: { origin: ORIGIN } });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json().custom, []);
    const answer = await ask(member, { provider: "custom", model: `${id}/llama-70b` });
    assert.notEqual(answer.statusCode, 200);
    assert.equal(used.length, 1);
    assert.ok(events.some((event) => event.eventType === "model_provider.remove"));
  });
});
