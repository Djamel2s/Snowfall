import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditEvent } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import type { MemberStore } from "../workspace/members.js";
import { defaultSettings, type OrganizationSettings, type SettingsStore, type UsageSummary } from "../workspace/settings.js";
import { API_KEY_PATTERN, keyHint, MemoryModelKeyStore } from "./keys.js";
import { ProviderRegistry, type ProviderAdapter } from "./registry.js";
import type { ProviderId, ProviderSettings } from "./types.js";

// Clés d'API saisies dans l'interface : quelle clé sert qui, et ce qui ne doit jamais sortir.

const ORIGIN = "http://localhost:5173";
const ORG = "11111111-1111-4111-8111-111111111111";
const member: AuthenticatedUser = { userId: "22222222-2222-4222-8222-222222222222", organizationId: ORG, role: "member" };
const colleague: AuthenticatedUser = { ...member, userId: "44444444-4444-4444-8444-444444444444" };
const admin: AuthenticatedUser = { ...member, userId: "33333333-3333-4333-8333-333333333333", role: "admin" };

const PLATFORM = "platform-key-0000";
const PERSONAL = "sk-personal-secret-1234";
const ORGANIZATION = "sk-organization-secret-5678";

/** Faux fournisseurs : notent la clé qui sert chaque appel ; une clé contenant « bad » est refusée. */
function fakeProviders() {
  const used: { provider: ProviderId; apiKey: string; baseUrl?: string | undefined }[] = [];
  const adapter = (id: ProviderId, settings: ProviderSettings): ProviderAdapter => ({
    list: async () => {
      if (settings.apiKey.includes("bad")) throw new Error("401");
      return [{ id: "m1", label: "M1" }];
    },
    create: (model) => ({
      id: `${id}:${model}`,
      supportsTools: true,
      async *stream() {
        used.push({ provider: id, apiKey: settings.apiKey, baseUrl: settings.baseUrl });
        yield { type: "token" as const, text: "ok" };
        yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 };
      },
    }),
  });
  const registry = new ProviderRegistry(
    { openai: { apiKey: PLATFORM, baseUrl: "http://proxy.platform.internal", maxOutputTokens: 100, timeoutMs: 1000 } },
    { defaultSelection: { provider: "openai", model: "m1" }, defaults: { maxOutputTokens: 100, timeoutMs: 1000 }, adapter },
  );
  return { registry, used };
}

const usage = (): UsageSummary => ({ period: "2026-11-01", total: { inputTokens: 0, outputTokens: 0 }, byProvider: {}, mine: { inputTokens: 0, outputTokens: 0 } });

function fakeSettings(initial: Partial<OrganizationSettings> = {}, current = usage()) {
  let settings: OrganizationSettings = { ...defaultSettings, ...initial };
  const recorded: { provider: string; tokens: number }[] = [];
  const store: SettingsStore = {
    get: async () => settings,
    update: async (_tenant, next) => (settings = next),
    usage: async () => current,
    usageByMember: async () => [],
    record: async (_tenant, provider, totals) => {
      recorded.push({ provider, tokens: totals.inputTokens + totals.outputTokens });
    },
  };
  return { store, recorded, set: (next: Partial<OrganizationSettings>) => (settings = { ...settings, ...next }) };
}

function setup(options: { settings?: Partial<OrganizationSettings>; usage?: UsageSummary } = {}) {
  const events: AuditEvent[] = [];
  const conversations = createFakeConversationStore();
  const keys = new MemoryModelKeyStore();
  const { registry, used } = fakeProviders();
  const settings = fakeSettings(options.settings, options.usage);
  let current: AuthenticatedUser = member;
  const app = createAppServer({
    appOrigin: ORIGIN,
    logger: false,
    conversationStore: conversations,
    authenticate: async () => current,
    audit: { record: async (_request, event) => void events.push(event) },
    models: registry,
    modelKeys: keys,
    settings: settings.store,
    // Réglages de l'organisation : la route n'utilise pas l'annuaire des membres.
    members: {} as MemberStore,
  });
  const as = (user: AuthenticatedUser) => (current = user);
  const send = async (user: AuthenticatedUser) => {
    as(user);
    const conversation = await conversations.create(user);
    return app.inject({ method: "POST", url: `/conversations/${conversation.id}/messages`, headers: { origin: ORIGIN }, payload: { content: "Bonjour" } });
  };
  const put = (user: AuthenticatedUser, url: string, apiKey: string) => {
    as(user);
    return app.inject({ method: "PUT", url, headers: { origin: ORIGIN }, payload: { apiKey } });
  };
  return { app, events, keys, used, settings, as, send, put };
}

describe("Clés d'API : registre vu par une personne", () => {
  it("la clé d'une personne sert ce fournisseur ; les autres gardent celle de la plateforme ; adresse officielle", async () => {
    const { registry, used } = fakeProviders();
    const view = registry.withKeys({ openai: { apiKey: PERSONAL, source: "personal" }, anthropic: { apiKey: ORGANIZATION, source: "organization" } });
    await view.runner({ provider: "openai", model: "m1" })({ message: "a" });
    await registry.runner({ provider: "openai", model: "m1" })({ message: "b" });
    await view.runner({ provider: "anthropic", model: "m1" })({ message: "c" });
    assert.deepEqual(
      used.map((call) => [call.provider, call.apiKey, call.baseUrl]),
      [
        ["openai", PERSONAL, undefined],
        ["openai", PLATFORM, "http://proxy.platform.internal"],
        ["anthropic", ORGANIZATION, undefined],
      ],
    );
    assert.equal(view.keySource?.("openai"), "personal");
    assert.equal(view.keySource?.("anthropic"), "organization");
    assert.equal(view.keySource?.("mistral"), "platform");
    // Fournisseur ouvert par une clé seulement : visible et capable d'outils dans cette vue, pas ailleurs.
    assert.equal((await view.catalog()).find((item) => item.id === "anthropic")?.available, true);
    assert.equal((await registry.catalog()).find((item) => item.id === "anthropic")?.available, false);
    assert.equal(view.supportsTools?.({ provider: "anthropic", model: "m1" }), true);
    assert.equal(registry.supportsTools?.({ provider: "anthropic", model: "m1" }), false);
  });

  it("deux personnes, deux clés : jamais le modèle (ni le cache) de l'autre", async () => {
    const { registry, used } = fakeProviders();
    const mine = registry.withKeys({ openai: { apiKey: "sk-mine-aaaa", source: "personal" } });
    const theirs = registry.withKeys({ openai: { apiKey: "sk-theirs-bbbb", source: "personal" } });
    await mine.runner({ provider: "openai", model: "m1" })({ message: "a" });
    await theirs.runner({ provider: "openai", model: "m1" })({ message: "b" });
    await mine.runner({ provider: "openai", model: "m1" })({ message: "c" });
    assert.deepEqual(used.map((call) => call.apiKey), ["sk-mine-aaaa", "sk-theirs-bbbb", "sk-mine-aaaa"]);
  });

  it("vérification d'une clé : refusée → erreur ; acceptée → nombre de modèles", async () => {
    const { registry } = fakeProviders();
    await assert.rejects(registry.checkKey("mistral", "sk-bad-key-0000"), /KEY_REJECTED/);
    assert.equal(await registry.checkKey("mistral", "sk-good-key-0000"), 1);
    // La clé vérifiée n'ouvre rien dans le registre de la plateforme.
    assert.equal((await registry.catalog()).find((item) => item.id === "mistral")?.available, false);
  });

  it("format : rien qui casse un en-tête (espace, retour à la ligne) ; indice de 4 caractères sûrs", () => {
    assert.equal(API_KEY_PATTERN.test("sk-abc def-123"), false);
    assert.equal(API_KEY_PATTERN.test(`sk-abc${String.fromCharCode(10)}X-Injected: 1`), false);
    assert.equal(API_KEY_PATTERN.test("court"), false);
    assert.equal(API_KEY_PATTERN.test(PERSONAL), true);
    assert.equal(keyHint("sk-abc<>%1"), "1");
  });
});

describe("Clés d'API : routes et chemins d'attaque", () => {
  it("clé personnelle refusée tant que l'organisation ne l'autorise pas (refus tracé, rien gardé)", async (t) => {
    const { app, events, keys, put } = setup();
    t.after(() => app.close());
    const response = await put(member, "/me/model-keys/openai", PERSONAL);
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().reason, "personal_keys_disabled");
    assert.deepEqual((await keys.list(member)).personal, []);
    assert.ok(events.some((event) => event.eventType === "model_key.personal_set" && event.outcome === "denied"));
  });

  it("autorisée : la clé personnelle sert SES réponses, hors quotas et budget de l'organisation ; jamais celles d'un collègue", async (t) => {
    const full = usage();
    full.total = { inputTokens: 5_000, outputTokens: 5_000 };
    const { app, used, settings, put, send } = setup({ settings: { personalKeyProviders: ["openai"], monthlyTokenLimit: 1_000 }, usage: full });
    t.after(() => app.close());

    assert.equal((await put(member, "/me/model-keys/openai", PERSONAL)).statusCode, 200);
    const mine = await send(member);
    assert.equal(mine.statusCode, 200);
    // Collègue : plafond de l'organisation atteint, clé de la plateforme (jamais celle du membre).
    const theirs = await send(colleague);
    assert.equal(theirs.statusCode, 429);
    assert.deepEqual(used.map((call) => call.apiKey), [PERSONAL]);
    // Consommation sur clé personnelle : pas comptée pour l'organisation.
    assert.deepEqual(settings.recorded, []);
  });

  it("politique retirée par l'administrateur : la clé personnelle ne sert plus aussitôt (retour aux plafonds de l'organisation)", async (t) => {
    const full = usage();
    full.total = { inputTokens: 5_000, outputTokens: 5_000 };
    const { app, used, put, send, as, events } = setup({ settings: { personalKeyProviders: ["openai"], monthlyTokenLimit: 1_000 }, usage: full });
    t.after(() => app.close());
    await put(member, "/me/model-keys/openai", PERSONAL);
    assert.equal((await send(member)).statusCode, 200);
    as(admin);
    const policy = await app.inject({
      method: "PUT",
      url: "/organization/settings",
      headers: { origin: ORIGIN },
      payload: { allowedProviders: ["openai"], monthlyTokenLimit: 1_000, providerTokenLimits: {}, personalKeyProviders: [] },
    });
    assert.equal(policy.statusCode, 200);
    assert.ok(events.some((event) => event.eventType === "security.personal_keys_policy"));
    // Sans attendre l'expiration du cache : la vue du membre est recalculée.
    assert.equal((await send(member)).statusCode, 429);
    assert.deepEqual(used.map((call) => call.apiKey), [PERSONAL]);
  });

  it("clé refusée par le fournisseur : 400, rien gardé ; format douteux : 400 avant tout appel", async (t) => {
    const { app, keys, put } = setup({ settings: { personalKeyProviders: ["openai"] } });
    t.after(() => app.close());
    const rejected = await put(member, "/me/model-keys/openai", "sk-bad-key-0000");
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().reason, "key_rejected");
    assert.equal((await put(member, "/me/model-keys/openai", "sk with space")).statusCode, 400);
    assert.equal((await put(member, "/me/model-keys/local", PERSONAL)).statusCode, 400);
    assert.deepEqual((await keys.list(member)).personal, []);
  });

  it("clé de l'organisation : administrateur seulement ; sert tout le monde ; un membre n'en voit pas l'indice", async (t) => {
    const { app, used, put, send, as } = setup();
    t.after(() => app.close());
    assert.equal((await put(member, "/organization/model-keys/openai", ORGANIZATION)).statusCode, 403);
    assert.equal((await put(admin, "/organization/model-keys/openai", ORGANIZATION)).statusCode, 200);
    await send(colleague);
    assert.deepEqual(used.map((call) => call.apiKey), [ORGANIZATION]);
    as(member);
    const listed = (await app.inject({ method: "GET", url: "/me/model-keys" })).json();
    const openai = listed.providers.find((item: { id: string }) => item.id === "openai");
    assert.equal(openai.active, "organization");
    assert.deepEqual(openai.organization, {});
  });

  it("la clé ne sort jamais : ni dans les réponses, ni dans le journal d'audit (ni son indice)", async (t) => {
    const { app, events, put, as } = setup({ settings: { personalKeyProviders: ["openai"] } });
    t.after(() => app.close());
    const saved = await put(member, "/me/model-keys/openai", PERSONAL);
    as(admin);
    const organization = await put(admin, "/organization/model-keys/openai", ORGANIZATION);
    as(member);
    const listed = await app.inject({ method: "GET", url: "/me/model-keys" });
    for (const body of [saved.body, organization.body, listed.body]) {
      assert.ok(!body.includes(PERSONAL) && !body.includes(ORGANIZATION));
    }
    assert.equal(listed.json().providers.find((item: { id: string }) => item.id === "openai").personal.hint, "1234");
    const audit = JSON.stringify(events);
    for (const secret of [PERSONAL, ORGANIZATION, "1234", "5678"]) assert.ok(!audit.includes(secret), secret);
    assert.ok(events.some((event) => event.eventType === "model_key.personal_set" && event.outcome === "success"));
    assert.ok(events.some((event) => event.eventType === "model_key.organization_set"));
  });

  it("retrait : la clé ne sert plus aussitôt (cache vidé) ; second retrait : 404", async (t) => {
    const { app, used, put, send, as } = setup({ settings: { personalKeyProviders: ["openai"] } });
    t.after(() => app.close());
    await put(member, "/me/model-keys/openai", PERSONAL);
    await send(member);
    as(member);
    assert.equal((await app.inject({ method: "DELETE", url: "/me/model-keys/openai", headers: { origin: ORIGIN } })).statusCode, 200);
    await send(member);
    assert.deepEqual(used.map((call) => call.apiKey), [PERSONAL, PLATFORM]);
    assert.equal((await app.inject({ method: "DELETE", url: "/me/model-keys/openai", headers: { origin: ORIGIN } })).statusCode, 404);
  });

  it("pas un banc d'essai de clés : 10 vérifications par minute et par personne", async (t) => {
    const { app, put } = setup({ settings: { personalKeyProviders: ["openai"] } });
    t.after(() => app.close());
    const codes: number[] = [];
    for (let attempt = 0; attempt < 11; attempt++) codes.push((await put(member, "/me/model-keys/openai", `sk-bad-key-${attempt}000`)).statusCode);
    assert.deepEqual(codes, [...Array(10).fill(400), 429]);
  });
});
