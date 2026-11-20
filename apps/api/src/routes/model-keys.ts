import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/auth.js";
import { API_KEY_PATTERN, isKeyProvider, keyProviders, type KeyProvider, type KeyScope, type ModelKeyStore } from "../llm/keys.js";
import { MAX_CUSTOM_PROVIDERS, type CustomEndpoint, type CustomProviderStore } from "../llm/custom-providers.js";
import type { ModelInfo, ProviderId } from "../llm/types.js";
import type { OrganizationSettings } from "../workspace/settings.js";
import type { RouteKit } from "./kit.js";

// Clés d'API des fournisseurs de modèles, saisies dans l'interface.
// - Un administrateur pose la clé de l'organisation (remplace celle de la plateforme).
// - Un membre pose SA clé, seulement pour les fournisseurs que l'organisation autorise.
// Une clé est vérifiée auprès du fournisseur avant d'être gardée ; elle n'est jamais
// renvoyée (4 derniers caractères seulement), ni écrite dans le journal d'audit.

export type ModelKeyDependencies = {
  store: ModelKeyStore;
  settings: (user: AuthenticatedUser) => Promise<OrganizationSettings>;
  /** Fournisseurs configurés par la plateforme (fichier de configuration). */
  platformProviders: () => ProviderId[];
  /** Vérifie la clé auprès du fournisseur ; lève si elle est refusée. */
  checkKey: (provider: KeyProvider, apiKey: string) => Promise<number>;
  /** Clés changées : vues des modèles à recalculer (toute l'organisation, ou une personne). */
  changed: (organizationId: string, userId?: string) => void;
  /** Fournisseurs personnalisés (serveurs compatibles OpenAI) de l'organisation. */
  custom?: CustomProviderDependencies | undefined;
};

export type CustomProviderDependencies = {
  store: CustomProviderStore;
  /** Adresse HTTPS publique ; lève sinon (règles anti-SSRF des connecteurs). */
  validateUrl: (raw: string) => URL;
  /** Liste les modèles du serveur ; lève s'il ne répond pas. */
  check: (endpoint: Omit<CustomEndpoint, "id" | "name">) => Promise<number>;
  /** Modèles publiés pour cette personne (« <id>/<modèle> »). */
  models: (user: AuthenticatedUser) => Promise<ModelInfo[]>;
};

const providerParams = z.object({ provider: z.enum(keyProviders) }).strict();
const keyBody = z.object({ apiKey: z.string().trim().regex(API_KEY_PATTERN) }).strict();
const customBody = z
  .object({
    name: z.string().trim().min(1).max(60),
    baseUrl: z.string().trim().min(1).max(500),
    apiKey: z.string().trim().regex(API_KEY_PATTERN).optional(),
  })
  .strict();
const customParams = z.object({ id: z.uuid() }).strict();

/** Adresse de base gardée : origine et chemin, sans identifiants, paramètres ni fragment. */
function baseUrlOf(url: URL) {
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function registerModelKeyRoutes(api: FastifyInstance, kit: RouteKit, deps: ModelKeyDependencies) {
  // Chaque vérification appelle le fournisseur : pas un banc d'essai de clés.
  const checkLimit = api.createRateLimit({ max: 10, timeWindow: "1 minute", keyGenerator: (request) => `model-key:${kit.principal(request).userId}` });

  async function customView(user: AuthenticatedUser, settings: OrganizationSettings, admin: boolean) {
    if (!deps.custom) return [];
    const [items, models] = await Promise.all([deps.custom.store.list(user), deps.custom.models(user).catch(() => [] as ModelInfo[])]);
    const allowed = settings.allowedProviders.includes("custom");
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      allowed,
      // Nombre de modèles publiés : 0, le serveur ne répond pas (ou plus).
      models: models.filter((model) => model.id.startsWith(`${item.id}/`)).length,
      // Adresse et indice de la clé : utiles aux administrateurs seulement.
      ...(admin ? { baseUrl: item.baseUrl, hint: item.hint } : {}),
    }));
  }

  async function view(user: AuthenticatedUser) {
    const [keys, settings] = await Promise.all([deps.store.list(user), deps.settings(user)]);
    const platform = deps.platformProviders();
    const admin = kit.isAdmin(user);
    return {
      custom: await customView(user, settings, admin),
      providers: keyProviders.map((id) => {
        const organization = keys.organization.find((key) => key.provider === id) ?? null;
        const personal = keys.personal.find((key) => key.provider === id) ?? null;
        const personalAllowed = settings.personalKeyProviders.includes(id);
        const allowed = settings.allowedProviders.includes(id);
        const active = !allowed ? null : personal && personalAllowed ? "personal" : organization ? "organization" : platform.includes(id) ? "platform" : null;
        return {
          id,
          allowed,
          personalAllowed,
          active,
          platform: platform.includes(id),
          // Indice et date de la clé de l'organisation : utiles aux administrateurs seulement.
          organization: organization ? (admin ? { hint: organization.hint, updatedAt: organization.updatedAt } : {}) : null,
          personal: personal ? { hint: personal.hint, updatedAt: personal.updatedAt } : null,
        };
      }),
    };
  }

  async function save(request: FastifyRequest, reply: FastifyReply, scope: KeyScope) {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (scope === "organization" && !kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const params = providerParams.safeParse(request.params);
    const body = keyBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });
    const { provider } = params.data;

    const settings = await deps.settings(user);
    if (!settings.allowedProviders.includes(provider)) return reply.code(403).send({ error: "Provider not allowed", reason: "provider_not_allowed" });
    if (scope === "personal" && !settings.personalKeyProviders.includes(provider)) {
      await kit.record(request, user, { eventType: "model_key.personal_set", outcome: "denied", details: { provider, reason: "personal_keys_disabled" } });
      return reply.code(403).send({ error: "Personal keys disabled", reason: "personal_keys_disabled" });
    }

    const limit = await checkLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    const models = await deps.checkKey(provider, body.data.apiKey).catch(() => 0);
    if (!models) {
      await kit.record(request, user, { eventType: `model_key.${scope}_set`, outcome: "failure", details: { provider, reason: "key_rejected" } });
      return reply.code(400).send({ error: "Key rejected", reason: "key_rejected" });
    }

    await deps.store.set(user, scope, provider, body.data.apiKey);
    deps.changed(user.organizationId, scope === "personal" ? user.userId : undefined);
    // Jamais la clé ni son indice dans l'audit : le fournisseur, le nombre de modèles ouverts.
    await kit.record(request, user, { eventType: `model_key.${scope}_set`, targetType: "model_provider", targetId: provider, details: { provider, models } });
    return view(user);
  }

  async function remove(request: FastifyRequest, reply: FastifyReply, scope: KeyScope) {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (scope === "organization" && !kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const params = providerParams.safeParse(request.params);
    if (!params.success || !isKeyProvider(params.data.provider)) return reply.code(400).send({ error: "Invalid request" });
    if (!(await deps.store.remove(user, scope, params.data.provider))) return reply.code(404).send({ error: "Not found" });
    deps.changed(user.organizationId, scope === "personal" ? user.userId : undefined);
    await kit.record(request, user, { eventType: `model_key.${scope}_remove`, targetType: "model_provider", targetId: params.data.provider, details: { provider: params.data.provider } });
    return view(user);
  }

  async function addCustom(request: FastifyRequest, reply: FastifyReply) {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const custom = deps.custom;
    const body = customBody.safeParse(request.body);
    if (!custom || !body.success) return reply.code(400).send({ error: "Invalid request" });

    let baseUrl: string | null = null;
    try {
      baseUrl = baseUrlOf(custom.validateUrl(body.data.baseUrl));
    } catch {
      baseUrl = null;
    }
    if (!baseUrl) return reply.code(400).send({ error: "Invalid URL", reason: "invalid_endpoint" });

    const settings = await deps.settings(user);
    if (!settings.allowedProviders.includes("custom")) return reply.code(403).send({ error: "Provider not allowed", reason: "provider_not_allowed" });
    if ((await custom.store.list(user)).length >= MAX_CUSTOM_PROVIDERS) return reply.code(409).send({ error: "Too many providers", reason: "too_many_providers" });

    const limit = await checkLimit(request);
    if (!limit.isAllowed && limit.isExceeded) return reply.code(429).send({ error: "Too many requests" });
    const host = new URL(baseUrl).host;
    const models = await custom.check({ baseUrl, apiKey: body.data.apiKey }).catch(() => 0);
    if (!models) {
      await kit.record(request, user, { eventType: "model_provider.create", outcome: "failure", details: { host, reason: "endpoint_rejected" } });
      return reply.code(400).send({ error: "Endpoint rejected", reason: "endpoint_rejected" });
    }

    const id = await custom.store.create(user, { name: body.data.name, baseUrl, apiKey: body.data.apiKey }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "TOO_MANY_PROVIDERS") return null;
      throw error;
    });
    if (!id) return reply.code(409).send({ error: "Too many providers", reason: "too_many_providers" });
    deps.changed(user.organizationId);
    // Jamais la clé ni son indice : le nom, l'hôte, le nombre de modèles ouverts.
    await kit.record(request, user, { eventType: "model_provider.create", targetType: "model_provider", targetId: id, details: { name: body.data.name, host, models, key: Boolean(body.data.apiKey) } });
    return view(user);
  }

  async function removeCustom(request: FastifyRequest, reply: FastifyReply) {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);
    const params = customParams.safeParse(request.params);
    if (!deps.custom || !params.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await deps.custom.store.remove(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
    deps.changed(user.organizationId);
    await kit.record(request, user, { eventType: "model_provider.remove", targetType: "model_provider", targetId: params.data.id });
    return view(user);
  }

  api.post("/organization/model-providers", addCustom);
  api.delete("/organization/model-providers/:id", removeCustom);

  api.get("/me/model-keys", async (request, reply) => {
    kit.privateResponse(reply);
    return view(kit.principal(request));
  });
  api.put("/me/model-keys/:provider", (request, reply) => save(request, reply, "personal"));
  api.delete("/me/model-keys/:provider", (request, reply) => remove(request, reply, "personal"));
  api.put("/organization/model-keys/:provider", (request, reply) => save(request, reply, "organization"));
  api.delete("/organization/model-keys/:provider", (request, reply) => remove(request, reply, "organization"));
}
