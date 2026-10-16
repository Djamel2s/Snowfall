import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { knownTools, toolIds } from "../agent/catalog.js";
import { organizationRoles } from "../auth/auth.js";
import { embeddingProviders, type EmbeddingProvider } from "../knowledge/embeddings.js";
import { providerIds, type ProviderId } from "../llm/types.js";
import type { ProjectStore } from "../projects/store.js";
import { MemberRuleError, type MemberStore } from "../workspace/members.js";
import { locales, type PreferencesStore } from "../workspace/preferences.js";
import type { SettingsStore } from "../workspace/settings.js";
import type { RouteKit } from "./kit.js";

export type WorkspaceDependencies = {
  settings?: SettingsStore | undefined;
  members?: MemberStore | undefined;
  preferences?: PreferencesStore | undefined;
  projects?: ProjectStore | undefined;
  /** Fournisseurs configurés sur la plateforme (clé d'API présente). */
  configuredProviders: () => Promise<ProviderId[]>;
  /** Fournisseurs configurés pour les embeddings. */
  embeddingProviders?: () => EmbeddingProvider[];
};

const uuidParams = z.object({ id: z.uuid() });
const memberParams = z.object({ userId: z.uuid() });
const MAX_TOKEN_LIMIT = 1_000_000_000_000;

const tokenLimit = z.number().int().positive().max(MAX_TOKEN_LIMIT);

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
}).strict();

const preferencesSchema = z.object({
  locale: z.enum(locales).nullable(),
  sendOnEnter: z.boolean(),
  reduceMotion: z.enum(["system", "on", "off"]),
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
      return { preferences: await preferences.update(user, body.data) };
    });
  }

  if (settings) {
    // Visible par tous les membres : consommation du mois et plafonds.
    api.get("/usage", async (request, reply) => {
      const user = kit.principal(request);
      kit.privateResponse(reply);
      const [usage, current] = await Promise.all([settings.usage(user), settings.get(user)]);
      return {
        usage,
        limits: { monthly: current.monthlyTokenLimit, providers: current.providerTokenLimits },
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
        deps.configuredProviders(),
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
      const saved = await settings.update(user, {
        allowedProviders: [...new Set(body.data.allowedProviders)],
        monthlyTokenLimit: body.data.monthlyTokenLimit,
        providerTokenLimits: body.data.providerTokenLimits,
        embeddingProvider,
        linksEnabled: body.data.linksEnabled ?? current.linksEnabled,
        linkDomains: body.data.linkDomains ? [...new Set(body.data.linkDomains)] : current.linkDomains,
        tools: body.data.tools ? knownTools(body.data.tools) : current.tools,
      });
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
