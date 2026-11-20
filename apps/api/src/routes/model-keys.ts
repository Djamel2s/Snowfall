import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedUser } from "../auth/auth.js";
import { API_KEY_PATTERN, isKeyProvider, keyProviders, type KeyProvider, type KeyScope, type ModelKeyStore } from "../llm/keys.js";
import type { ProviderId } from "../llm/types.js";
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
};

const providerParams = z.object({ provider: z.enum(keyProviders) }).strict();
const keyBody = z.object({ apiKey: z.string().trim().regex(API_KEY_PATTERN) }).strict();

export function registerModelKeyRoutes(api: FastifyInstance, kit: RouteKit, deps: ModelKeyDependencies) {
  // Chaque vérification appelle le fournisseur : pas un banc d'essai de clés.
  const checkLimit = api.createRateLimit({ max: 10, timeWindow: "1 minute", keyGenerator: (request) => `model-key:${kit.principal(request).userId}` });

  async function view(user: AuthenticatedUser) {
    const [keys, settings] = await Promise.all([deps.store.list(user), deps.settings(user)]);
    const platform = deps.platformProviders();
    const admin = kit.isAdmin(user);
    return {
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

  api.get("/me/model-keys", async (request, reply) => {
    kit.privateResponse(reply);
    return view(kit.principal(request));
  });
  api.put("/me/model-keys/:provider", (request, reply) => save(request, reply, "personal"));
  api.delete("/me/model-keys/:provider", (request, reply) => remove(request, reply, "personal"));
  api.put("/organization/model-keys/:provider", (request, reply) => save(request, reply, "organization"));
  api.delete("/organization/model-keys/:provider", (request, reply) => remove(request, reply, "organization"));
}
