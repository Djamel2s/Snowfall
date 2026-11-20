import { PRICE_KEY, MAX_PRICED_MODELS, MAX_TOKEN_PRICE, MAX_TOOL_PRICE, priceOf, tokenCost } from "../workspace/costs.js";
import type { FastifyInstance } from "fastify";
import { detectSensitive } from "../security/sensitive.js";
import { detectInjection } from "../security/injection.js";
import { z } from "zod";
import { knownTools, toolIds, type ToolId } from "../agent/catalog.js";
import { organizationRoles, type AuthenticatedUser } from "../auth/auth.js";
import { embeddingProviders, type EmbeddingProvider } from "../knowledge/embeddings.js";
import { keyProviders } from "../llm/keys.js";
import { providerIds, type ProviderId } from "../llm/types.js";
import type { ProjectStore } from "../projects/store.js";
import { MemberRuleError, type MemberStore } from "../workspace/members.js";
import { locales, MAX_INSTRUCTIONS, themes, type PreferencesStore } from "../workspace/preferences.js";
import { toolMeters, type SettingsStore, type ToolUsageStore } from "../workspace/settings.js";
import type { RouteKit } from "./kit.js";

export type WorkspaceDependencies = {
  settings?: SettingsStore | undefined;
  members?: MemberStore | undefined;
  preferences?: PreferencesStore | undefined;
  projects?: ProjectStore | undefined;
  /** Fournisseurs configurés sur la plateforme (clé d'API présente). */
  /** Fournisseurs disponibles pour cette personne (clés de la plateforme, de l'organisation, la sienne). */
  configuredProviders: (user: AuthenticatedUser) => Promise<ProviderId[]>;
  /** Fournisseurs configurés pour les embeddings. */
  embeddingProviders?: () => EmbeddingProvider[];
  /** Outils que la plateforme sait fournir (la recherche web exige SearXNG). */
  platformTools?: () => ToolId[];
  /** Appels d'outils du mois (quotas des outils). */
  toolUsage?: ToolUsageStore | undefined;
  /** Le modèle existe chez ce fournisseur (catalogue de la plateforme). */
  isModelAllowed?: (user: AuthenticatedUser, selection: { provider: ProviderId; model: string }) => Promise<boolean>;
  settingsChanged?: (organizationId: string) => void;
};

const uuidParams = z.object({ id: z.uuid() });
const memberParams = z.object({ userId: z.uuid() });
const MAX_TOKEN_LIMIT = 1_000_000_000_000;

const tokenLimit = z.number().int().positive().max(MAX_TOKEN_LIMIT);
/** Tarif : euros, au millième de centime près (prix au million de jetons). */
const price = (max: number) => z.number().min(0).max(max).transform((value) => Math.round(value * 100_000) / 100_000);
/** Budget mensuel : euros, au centime (au moins un centime). */
const budget = z.number().min(0.01).max(100_000_000).transform((value) => Math.round(value * 100) / 100);

const settingsSchema = z.object({
  allowedProviders: z.array(z.enum(providerIds)).max(providerIds.length),
  monthlyTokenLimit: tokenLimit.nullable(),
  providerTokenLimits: z.partialRecord(z.enum(providerIds), tokenLimit),
  // Champs facultatifs : absents, la valeur enregistrée est conservée.
  embeddingProvider: z.enum(embeddingProviders).nullable().optional(),
  linksEnabled: z.boolean().optional(),
  linkDomains: z
    .array(
      z.string().trim().toLowerCase().max(253)
        .regex(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    )
    .max(200)
    .optional(),
  tools: z.array(z.enum(toolIds)).max(toolIds.length).optional(),
  toolLimits: z.partialRecord(z.enum(toolMeters), z.number().int().positive().max(10_000_000)).optional(),
  // Données sensibles : « local » (défaut) ou « off » ; absent = inchangé.
  sensitiveData: z.enum(["local", "off"]).optional(),
  // Pseudonymisation avant un fournisseur externe ; absent = inchangé.
  pseudonymize: z.boolean().optional(),
  // Clés d'API personnelles autorisées (par fournisseur) ; absent = inchangé.
  personalKeyProviders: z.array(z.enum(keyProviders)).max(keyProviders.length).optional(),
  // Routage automatique : null = désactivé ; absent = inchangé.
  modelRouting: z
    .object({
      fast: z.object({ provider: z.enum(providerIds), model: z.string().min(1).max(120) }).strict(),
      strong: z.object({ provider: z.enum(providerIds), model: z.string().min(1).max(120) }).strict(),
    })
    .strict()
    .nullable()
    .optional(),
  // Coûts et limites ; absents = inchangés.
  prices: z
    .object({
      models: z
        .record(z.string().regex(PRICE_KEY), z.object({ input: price(MAX_TOKEN_PRICE), output: price(MAX_TOKEN_PRICE) }).strict())
        .refine((models) => Object.keys(models).length <= MAX_PRICED_MODELS),
      tools: z.partialRecord(z.enum(toolMeters), price(MAX_TOOL_PRICE)),
    })
    .strict()
    .optional(),
  monthlyBudget: budget.nullable().optional(),
  memberMonthlyBudget: budget.nullable().optional(),
  memberToolLimits: z.partialRecord(z.enum(toolMeters), z.number().int().positive().max(10_000_000)).optional(),
  responseMaxTokens: z.number().int().min(1_000).max(5_000_000).nullable().optional(),
  responseMaxSeconds: z.number().int().min(10).max(3_600).nullable().optional(),
}).strict();

/** Instructions personnalisées refusées : donnée sensible ou tentative d'injection. */
/** Instructions écrites par l'utilisateur (profil, conversation, préréglage) : elles partent vers le modèle. */
export function instructionsRejection(text: string): "sensitive" | "injection" | null {
  if (detectSensitive(text).length) return "sensitive";
  if (detectInjection(text).suspicious) return "injection";
  return null;
}

const preferencesSchema = z.object({
  locale: z.enum(locales).nullable(),
  sendOnEnter: z.boolean(),
  reduceMotion: z.enum(["system", "on", "off"]),
  // Absent (ancien client) : la mémoire reste désactivée.
  memory: z.boolean().default(false),
  theme: z.enum(themes).default("system"),
  instructions: z.string().max(MAX_INSTRUCTIONS).default(""),
}).strict();

const projectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

const ssoSchema = z.object({
  alias: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/).nullable(),
  defaultRole: z.enum(["member", "reader"]),
}).strict();

const inviteSchema = z.object({
  email: z.email().max(254).transform((email) => email.toLowerCase()),
  role: z.enum(["admin", "member", "reader"]),
}).strict();

const roleSchema = z.object({ role: z.enum(organizationRoles) }).strict();

export function registerWorkspaceRoutes(api: FastifyInstance, kit: RouteKit, deps: WorkspaceDependencies) {
  const { settings, members, preferences, projects } = deps;

  if (preferences) {
    api.get("/me/preferences", async (request, reply) => {
      kit.privateResponse(reply);
      return { preferences: await preferences.get(kit.principal(request)) };
    });

    api.put("/me/preferences", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const body = preferencesSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });
      // Elles partent avec chaque message : ni donnée sensible, ni lien, ni consigne déguisée.
      const rejected = body.data.instructions.trim() ? instructionsRejection(body.data.instructions) : null;
      if (rejected) return reply.code(400).send({ error: "Invalid request", reason: `instructions_${rejected}` });
      return { preferences: await preferences.update(user, body.data) };
    });
  }

  if (settings) {
    // Visible par tous les membres : consommation du mois et plafonds.
    api.get("/usage", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const [usage, current, tools, myTools] = await Promise.all([
        settings.usage(user),
        settings.get(user),
        deps.toolUsage?.toolUsage(user) ?? {},
        deps.toolUsage?.memberToolUsage(user) ?? {},
      ]);
      return {
        usage: {
          period: usage.period,
          total: usage.total,
          byProvider: usage.byProvider,
          mine: usage.mine,
          tools,
          myTools,
          ...(usage.spend ? { mySpend: Math.round(usage.spend.mine.euros * 100) / 100 } : {}),
          ...(usage.spend && kit.isAdmin(user) ? { spend: Math.round(usage.spend.organization.euros * 100) / 100 } : {}),
        },
        limits: {
          monthly: current.monthlyTokenLimit,
          providers: current.providerTokenLimits,
          tools: current.toolLimits,
          memberTools: current.memberToolLimits,
          memberBudget: current.memberMonthlyBudget,
          ...(kit.isAdmin(user) ? { budget: current.monthlyBudget } : {}),
        },
      };
    });

    // Coûts du mois par modèle et par outil, aux tarifs actuels (administrateurs).
    api.get("/organization/costs", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });
      const [usage, current] = await Promise.all([settings.usage(user), settings.get(user)]);
      const round = (value: number) => Math.round(value * 100) / 100;
      const models = (usage.models ?? [])
        .filter((row) => row.provider !== "echo" && row.inputTokens + row.outputTokens > 0)
        .map((row) => {
          const rate = priceOf(current.prices, row.provider, row.model);
          return { ...row, euros: rate ? round(tokenCost(rate, row)) : null };
        })
        .sort((a, b) => (b.euros ?? 0) - (a.euros ?? 0) || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
      const tools = toolMeters
        .filter((meter) => usage.tools?.[meter])
        .map((meter) => ({ meter, calls: usage.tools![meter]!, euros: round((current.prices.tools[meter] ?? 0) * usage.tools![meter]!) }));
      return {
        period: usage.period,
        models,
        tools,
        total: round(usage.spend?.organization.euros ?? 0),
        unpriced: usage.spend?.organization.unpriced ?? [],
        budget: current.monthlyBudget,
        prices: current.prices,
      };
    });
  }

  if (members && settings) {
    api.get("/organization", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const [organization, current, configured] = await Promise.all([
        members.organization(user),
        settings.get(user),
        deps.configuredProviders(user),
      ]);
      return {
        organization: {
          id: organization.id,
          name: organization.name,
          // La liaison SSO n'est utile qu'aux administrateurs.
          ...(kit.isAdmin(user) ? { sso: organization.sso } : {}),
        },
        settings: current,
        configuredProviders: configured,
        embeddingProviders: deps.embeddingProviders?.() ?? [],
        platformTools: deps.platformTools?.() ?? [...toolIds],
      };
    });

    api.put("/organization/settings", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

      const body = settingsSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });

      const current = await settings.get(user);
      const embeddingProvider = body.data.embeddingProvider === undefined ? current.embeddingProvider : body.data.embeddingProvider;
      // Embeddings : uniquement par un fournisseur configuré et autorisé.
      if (
        embeddingProvider &&
        (!(deps.embeddingProviders?.() ?? []).includes(embeddingProvider) ||
          (embeddingProvider !== "local" && !body.data.allowedProviders.includes(embeddingProvider)))
      ) {
        return reply.code(400).send({ error: "Invalid request" });
      }
      // Routage : deux modèles existants, chez des fournisseurs autorisés par l'organisation.
      const modelRouting = body.data.modelRouting === undefined ? current.modelRouting : body.data.modelRouting;
      // Revalidé seulement s'il change : un modèle retiré du catalogue ne bloque pas les autres réglages
      // (à l'usage, il retombe sur le modèle par défaut).
      if (modelRouting && JSON.stringify(modelRouting) !== JSON.stringify(current.modelRouting)) {
        for (const selection of [modelRouting.fast, modelRouting.strong]) {
          const allowedHere = selection.provider === "local" || body.data.allowedProviders.includes(selection.provider);
          if (!allowedHere || (deps.isModelAllowed && !(await deps.isModelAllowed(user, selection)))) return reply.code(400).send({ error: "Invalid request", reason: "routing_model" });
        }
      }
      const sensitiveData = body.data.sensitiveData ?? current.sensitiveData;
      // Désactiver la protection est une décision tracée à part.
      if (sensitiveData !== current.sensitiveData) {
        await kit.record(request, user, { eventType: "security.sensitive_policy", details: { value: sensitiveData } });
      }
      const pseudonymize = body.data.pseudonymize ?? current.pseudonymize;
      if (pseudonymize !== current.pseudonymize) {
        await kit.record(request, user, { eventType: "security.pseudonymize_policy", details: { value: pseudonymize } });
      }
      const personalKeyProviders = body.data.personalKeyProviders ? [...new Set(body.data.personalKeyProviders)] : current.personalKeyProviders;
      // Autoriser les clés personnelles fait sortir des données du contrat de l'organisation : tracé à part.
      if (personalKeyProviders.join(",") !== current.personalKeyProviders.join(",")) {
        await kit.record(request, user, { eventType: "security.personal_keys_policy", details: { providers: personalKeyProviders.join(",") } });
      }
      const saved = await settings.update(user, {
        personalKeyProviders,
        pseudonymize,
        sensitiveData,
        modelRouting,
        allowedProviders: [...new Set(body.data.allowedProviders)],
        monthlyTokenLimit: body.data.monthlyTokenLimit,
        providerTokenLimits: body.data.providerTokenLimits,
        embeddingProvider,
        linksEnabled: body.data.linksEnabled ?? current.linksEnabled,
        linkDomains: body.data.linkDomains ? [...new Set(body.data.linkDomains)] : current.linkDomains,
        tools: body.data.tools ? knownTools(body.data.tools) : current.tools,
        toolLimits: body.data.toolLimits ?? current.toolLimits,
        prices: body.data.prices ?? current.prices,
        monthlyBudget: body.data.monthlyBudget === undefined ? current.monthlyBudget : body.data.monthlyBudget,
        memberMonthlyBudget: body.data.memberMonthlyBudget === undefined ? current.memberMonthlyBudget : body.data.memberMonthlyBudget,
        memberToolLimits: body.data.memberToolLimits ?? current.memberToolLimits,
        responseMaxTokens: body.data.responseMaxTokens === undefined ? current.responseMaxTokens : body.data.responseMaxTokens,
        responseMaxSeconds: body.data.responseMaxSeconds === undefined ? current.responseMaxSeconds : body.data.responseMaxSeconds,
      });
      deps.settingsChanged?.(user.organizationId);
      await kit.record(request, user, {
        eventType: "organization.settings_update",
        targetType: "organization",
        targetId: user.organizationId,
        details: {
          allowedProviders: saved.allowedProviders.join(","),
          monthlyTokenLimit: saved.monthlyTokenLimit ?? 0,
          embeddingProvider: saved.embeddingProvider ?? "",
          linksEnabled: saved.linksEnabled,
          linkDomains: saved.linkDomains.length,
          tools: saved.tools.join(","),
          toolLimits: toolMeters.map((meter) => `${meter}:${saved.toolLimits[meter] ?? "-"}`).join(","),
          memberToolLimits: toolMeters.map((meter) => `${meter}:${saved.memberToolLimits[meter] ?? "-"}`).join(","),
          monthlyBudget: saved.monthlyBudget ?? 0,
          memberMonthlyBudget: saved.memberMonthlyBudget ?? 0,
          pricedModels: Object.keys(saved.prices.models).length,
          responseMaxTokens: saved.responseMaxTokens ?? 0,
          responseMaxSeconds: saved.responseMaxSeconds ?? 0,
        },
      });
      return { settings: saved };
    });

    api.put("/organization/sso", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (user.role !== "owner") return kit.denyWrite(request, reply, user);

      const body = ssoSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });

      try {
        await members.setSso(user, body.data.alias, body.data.defaultRole);
      } catch (error) {
        if (error instanceof MemberRuleError && error.code === "CONFLICT") {
          return reply.code(409).send({ error: "Conflict" });
        }
        throw error;
      }
      await kit.record(request, user, {
        eventType: "organization.sso_update",
        targetType: "organization",
        targetId: user.organizationId,
        details: { alias: body.data.alias ?? "", defaultRole: body.data.defaultRole },
      });
      return { sso: body.data };
    });

    api.get("/organization/members", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

      const [list, invitations, usage] = await Promise.all([
        members.list(user),
        members.invitations(user),
        settings.usageByMember(user),
      ]);
      const tokensByUser = new Map(usage.map((row) => [row.userId, row.tokens]));
      return {
        members: list.map((member) => ({ ...member, monthlyTokens: tokensByUser.get(member.userId) ?? 0 })),
        invitations,
      };
    });

    const memberRuleResponse = (error: unknown) => {
      if (!(error instanceof MemberRuleError)) throw error;
      return error.code === "MEMBER_NOT_FOUND" ? 404 : 403;
    };

    api.patch("/organization/members/:userId", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

      const params = memberParams.safeParse(request.params);
      const body = roleSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });

      try {
        await members.setRole(user, params.data.userId, body.data.role);
      } catch (error) {
        const status = memberRuleResponse(error);
        await kit.record(request, user, {
          eventType: "organization.member_role",
          outcome: "denied",
          targetType: "user",
          targetId: params.data.userId,
          details: { role: body.data.role },
        });
        return reply.code(status).send({ error: status === 404 ? "Not found" : "Forbidden" });
      }
      await kit.record(request, user, {
        eventType: "organization.member_role",
        targetType: "user",
        targetId: params.data.userId,
        details: { role: body.data.role },
      });
      return reply.code(204).send();
    });

    api.delete("/organization/members/:userId", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

      const params = memberParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });

      try {
        await members.remove(user, params.data.userId);
      } catch (error) {
        const status = memberRuleResponse(error);
        return reply.code(status).send({ error: status === 404 ? "Not found" : "Forbidden" });
      }
      await kit.record(request, user, {
        eventType: "organization.member_remove",
        targetType: "user",
        targetId: params.data.userId,
      });
      return reply.code(204).send();
    });

    api.post("/organization/invitations", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

      const body = inviteSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });

      try {
        const invitation = await members.invite(user, body.data.email, body.data.role);
        // Pas d'e-mail en clair dans l'audit : seulement l'identifiant.
        await kit.record(request, user, {
          eventType: "organization.invitation_create",
          targetType: "invitation",
          targetId: invitation.id,
          details: { role: invitation.role },
        });
        return reply.code(201).send({ invitation });
      } catch (error) {
        if (error instanceof MemberRuleError && error.code === "CONFLICT") {
          return reply.code(409).send({ error: "Conflict" });
        }
        throw error;
      }
    });

    api.delete("/organization/invitations/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.isAdmin(user)) return kit.denyWrite(request, reply, user);

      const params = uuidParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      if (!(await members.revokeInvitation(user, params.data.id))) {
        return reply.code(404).send({ error: "Not found" });
      }
      await kit.record(request, user, {
        eventType: "organization.invitation_revoke",
        targetType: "invitation",
        targetId: params.data.id,
      });
      return reply.code(204).send();
    });
  }

  if (projects) {
    api.get("/projects", async (request, reply) => {
      kit.privateResponse(reply);
      return { projects: await projects.list(kit.principal(request)) };
    });

    api.post("/projects", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const body = projectSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Invalid request" });

      const project = await projects.create(user, body.data.name);
      await kit.record(request, user, { eventType: "project.create", targetType: "project", targetId: project.id });
      return reply.code(201).send({ project });
    });

    api.patch("/projects/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = uuidParams.safeParse(request.params);
      const body = projectSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Invalid request" });

      const project = await projects.rename(user, params.data.id, body.data.name);
      if (!project) return reply.code(404).send({ error: "Not found" });
      await kit.record(request, user, { eventType: "project.rename", targetType: "project", targetId: project.id });
      return { project };
    });

    api.delete("/projects/:id", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      if (!kit.canWrite(user)) return kit.denyWrite(request, reply, user);

      const params = uuidParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Invalid request" });
      if (!(await projects.delete(user, params.data.id))) return reply.code(404).send({ error: "Not found" });
      await kit.record(request, user, { eventType: "project.delete", targetType: "project", targetId: params.data.id });
      return reply.code(204).send();
    });
  }
}
