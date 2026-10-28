import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ScimFilter, ScimUser, ScimUserInput, ScimUserStore } from "../scim/store.js";
import { MemberRuleError, type MemberStore } from "../workspace/members.js";
import type { RouteKit } from "./kit.js";

// SCIM 2.0 (RFC 7643 / 7644) : l'annuaire de l'entreprise (Entra ID, Okta…)
// pousse les comptes. Une clé SCIM (« snowfall_scim_… ») agit au nom de
// l'administrateur qui l'a créée, tant qu'il est administrateur.
// - créé / actif : la personne rejoint à sa connexion (rôle par défaut) ;
// - désactivé / supprimé : son appartenance est retirée tout de suite (avec ses
//   partages et ses invitations en attente) : l'accès s'arrête à la requête suivante.
// Ressource « User » seulement (pas de groupes pour l'instant).

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const MAX_COUNT = 100;

export type ScimDependencies = { users: ScimUserStore; members: MemberStore; baseUrl: string };

const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u);
const email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+$/);

/** Corps d'une ressource User (création, remplacement) : seuls ces champs comptent. */
const userBody = z
  .object({
    userName: z.string().max(254),
    externalId: text(255).optional().nullable(),
    displayName: text(200).optional().nullable(),
    name: z.object({ formatted: text(200).optional(), givenName: text(100).optional(), familyName: text(100).optional() }).partial().optional(),
    emails: z.array(z.object({ value: z.string().max(254), primary: z.union([z.boolean(), z.string()]).optional() }).passthrough()).max(20).optional(),
    active: z.union([z.boolean(), z.enum(["true", "false", "True", "False"])]).optional(),
  })
  .passthrough();

const patchBody = z.object({
  Operations: z
    .array(z.object({ op: z.string().max(10), path: z.string().max(200).optional(), value: z.unknown().optional() }).passthrough())
    .min(1)
    .max(50),
});

const bool = (value: unknown) => value === true || value === "true" || value === "True";

/** userName = l'adresse e-mail ; sinon, l'adresse principale (Entra envoie parfois un UPN). */
function emailOf(body: z.infer<typeof userBody>): string | null {
  const direct = email.safeParse(body.userName);
  if (direct.success) return direct.data;
  const primary = body.emails?.find((item) => bool(item.primary)) ?? body.emails?.[0];
  const parsed = email.safeParse(primary?.value ?? "");
  return parsed.success ? parsed.data : null;
}

function displayOf(body: z.infer<typeof userBody>) {
  const joined = [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ");
  return body.displayName ?? body.name?.formatted ?? (joined || null);
}

export function registerScimRoutes(api: FastifyInstance, kit: RouteKit, deps: ScimDependencies) {
  const scim = { config: { scimKey: true, csrfExempt: true } } as const;
  const checkLimit = api.createRateLimit({ max: 300, timeWindow: "1 minute", keyGenerator: (request) => `scim-key:${request.apiKey?.keyId ?? request.ip}` });

  // Les annuaires envoient « application/scim+json » : du JSON.
  api.addContentTypeParser("application/scim+json", { parseAs: "string", bodyLimit: 256 * 1024 }, (_request, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Invalid JSON"), { statusCode: 400 }), undefined);
    }
  });

  const error = (reply: FastifyReply, status: number, detail: string, scimType?: string) =>
    reply
      .code(status)
      .header("Content-Type", "application/scim+json")
      .send({ schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });

  const resource = (user: ScimUser) => ({
    schemas: [USER_SCHEMA],
    id: user.id,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    userName: user.userName,
    ...(user.displayName ? { displayName: user.displayName, name: { formatted: user.displayName } } : {}),
    emails: [{ value: user.userName, primary: true, type: "work" }],
    active: user.active,
    meta: { resourceType: "User", created: user.createdAt, lastModified: user.updatedAt, location: `${deps.baseUrl}/scim/v2/Users/${user.id}` },
  });

  const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).header("Content-Type", "application/scim+json").send(body);

  async function guard(request: FastifyRequest, reply: FastifyReply) {
    kit.privateResponse(reply);
    const limit = await checkLimit(request);
    if (!limit.isAllowed && limit.isExceeded) {
      await error(reply, 429, "Too many requests");
      return false;
    }
    return true;
  }

  const audit = (request: FastifyRequest, eventType: string, user: ScimUser | null, details: Record<string, string | number | boolean> = {}, outcome?: "failure" | "denied") =>
    kit.record(request, kit.principal(request), {
      eventType,
      ...(outcome ? { outcome } : {}),
      targetType: "scim_user",
      ...(user ? { targetId: user.id } : {}),
      details: { key: request.apiKey?.keyId ?? "", ...details },
    });

  /**
   * Retrait d'accès : appartenance (et partages) retirés, invitations en attente
   * annulées. Échec (ex. retirer un propriétaire) : signalé à l'annuaire, jamais
   * silencieux — sinon l'accès resterait ouvert sans que personne le sache.
   */
  async function deprovision(request: FastifyRequest, user: ScimUser): Promise<string | null> {
    const tenant = kit.principal(request);
    for (const invitation of await deps.members.invitations(tenant)) {
      if (invitation.email.toLowerCase() === user.userName) await deps.members.revokeInvitation(tenant, invitation.id);
    }
    const member = (await deps.members.list(tenant)).find((item) => item.email.toLowerCase() === user.userName);
    if (!member) return null;
    try {
      await deps.members.remove(tenant, member.userId);
      await audit(request, "scim.deprovision", user, { removed: true });
      return null;
    } catch (cause) {
      const code = cause instanceof MemberRuleError ? cause.code : "ERROR";
      await audit(request, "scim.deprovision", user, { removed: false, reason: code }, "failure");
      return code === "SELF_CHANGE_FORBIDDEN" ? "The SCIM token owner cannot deprovision themselves" : code === "FORBIDDEN" ? "Only an owner can deprovision an owner" : "Deprovisioning failed";
    }
  }

  // ---- Découverte (ce que l'annuaire peut demander) ---------------------------

  api.get("/scim/v2/ServiceProviderConfig", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    return send(reply, 200, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_COUNT },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer", description: "Clé SCIM Snowfall (snowfall_scim_…)" }],
    });
  });

  api.get("/scim/v2/ResourceTypes", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    return send(reply, 200, {
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      Resources: [{ schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA }],
    });
  });

  // ---- Utilisateurs -------------------------------------------------------------

  api.get("/scim/v2/Users", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const query = z
      .object({ filter: z.string().max(300).optional(), startIndex: z.coerce.number().int().min(1).max(1_000_000).default(1), count: z.coerce.number().int().min(0).max(1_000).default(MAX_COUNT) })
      .safeParse(request.query);
    if (!query.success) return error(reply, 400, "Invalid query", "invalidValue");
    // Filtres utilisés par les annuaires : userName eq "…" et externalId eq "…".
    let filter: ScimFilter | null = null;
    if (query.data.filter) {
      const match = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(query.data.filter);
      if (!match) return error(reply, 400, "Only 'userName eq' and 'externalId eq' filters are supported", "invalidFilter");
      filter = { attribute: match[1]!.toLowerCase() === "username" ? "userName" : "externalId", value: match[2]!.replace(/\\(.)/g, "$1") };
    }
    const count = Math.min(query.data.count, MAX_COUNT);
    const page = await deps.users.list(kit.principal(request), filter, query.data.startIndex, count);
    return send(reply, 200, { schemas: [LIST_SCHEMA], totalResults: page.total, startIndex: query.data.startIndex, itemsPerPage: page.items.length, Resources: page.items.map(resource) });
  });

  api.get("/scim/v2/Users/:id", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    const user = params.success ? await deps.users.get(kit.principal(request), params.data.id) : null;
    if (!user) return error(reply, 404, "User not found");
    return send(reply, 200, resource(user));
  });

  api.post("/scim/v2/Users", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const body = userBody.safeParse(request.body);
    if (!body.success) return error(reply, 400, "Invalid user", "invalidValue");
    const userName = emailOf(body.data);
    if (!userName) return error(reply, 400, "userName (or a primary e-mail) must be an e-mail address", "invalidValue");
    const input: ScimUserInput = { userName, externalId: body.data.externalId ?? null, displayName: displayOf(body.data), active: body.data.active === undefined ? true : bool(body.data.active) };
    const created = await deps.users.create(kit.principal(request), input);
    if (created === "conflict") return error(reply, 409, "userName already exists", "uniqueness");
    await audit(request, "scim.user_create", created, { active: created.active });
    // Créé inactif alors qu'il était déjà membre : accès retiré.
    if (!created.active) {
      const failed = await deprovision(request, created);
      if (failed) return error(reply, 409, failed);
    }
    return send(reply, 201, resource(created));
  });

  async function save(request: FastifyRequest, reply: FastifyReply, id: string, next: (current: ScimUser) => ScimUserInput | string) {
    const tenant = kit.principal(request);
    const current = await deps.users.get(tenant, id);
    if (!current) return error(reply, 404, "User not found");
    const input = next(current);
    if (typeof input === "string") return error(reply, 400, input, "invalidValue");
    const updated = await deps.users.update(tenant, id, input);
    if (updated === "conflict") return error(reply, 409, "userName already exists", "uniqueness");
    if (!updated) return error(reply, 404, "User not found");
    await audit(request, current.active && !updated.active ? "scim.user_deactivate" : "scim.user_update", updated, { active: updated.active });
    if (!updated.active) {
      const failed = await deprovision(request, updated);
      if (failed) return error(reply, 409, failed);
    }
    // Adresse changée : l'ancienne n'ouvre plus rien (accès retiré pour elle).
    if (updated.userName !== current.userName && current.active) {
      const failed = await deprovision(request, { ...current, active: false });
      if (failed) return error(reply, 409, failed);
    }
    return send(reply, 200, resource(updated));
  }

  api.put("/scim/v2/Users/:id", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    const body = userBody.safeParse(request.body);
    if (!params.success) return error(reply, 404, "User not found");
    if (!body.success) return error(reply, 400, "Invalid user", "invalidValue");
    return save(request, reply, params.data.id, () => {
      const userName = emailOf(body.data);
      if (!userName) return "userName (or a primary e-mail) must be an e-mail address";
      return { userName, externalId: body.data.externalId ?? null, displayName: displayOf(body.data), active: body.data.active === undefined ? true : bool(body.data.active) };
    });
  });

  api.patch("/scim/v2/Users/:id", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    const body = patchBody.safeParse(request.body);
    if (!params.success) return error(reply, 404, "User not found");
    if (!body.success) return error(reply, 400, `Invalid PatchOp (${PATCH_SCHEMA})`, "invalidSyntax");
    return save(request, reply, params.data.id, (current) => {
      const next: ScimUserInput = { userName: current.userName, externalId: current.externalId, displayName: current.displayName, active: current.active };
      for (const operation of body.data.Operations) {
        const op = operation.op.toLowerCase();
        if (op !== "replace" && op !== "add" && op !== "remove") return `Unsupported op: ${operation.op}`;
        // Sans chemin : un objet d'attributs (Okta) ; avec chemin : un attribut (Entra ID).
        const changes: Record<string, unknown> =
          operation.path === undefined ? ((operation.value ?? {}) as Record<string, unknown>) : { [operation.path]: op === "remove" ? null : operation.value };
        for (const [path, value] of Object.entries(changes)) {
          const key = path.toLowerCase();
          if (key === "active") next.active = bool(value);
          else if (key === "username") {
            const parsed = email.safeParse(value);
            if (!parsed.success) return "userName must be an e-mail address";
            next.userName = parsed.data;
          } else if (key === "externalid") next.externalId = value === null ? null : text(255).safeParse(value).data ?? next.externalId;
          else if (key === "displayname" || key === "name.formatted") next.displayName = value === null ? null : text(200).safeParse(value).data ?? next.displayName;
          // Autres attributs (téléphone, titre, manager…) : non gardés (moindre donnée).
        }
      }
      return next;
    });
  });

  api.delete("/scim/v2/Users/:id", scim, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return error(reply, 404, "User not found");
    const tenant = kit.principal(request);
    const current = await deps.users.get(tenant, params.data.id);
    if (!current) return error(reply, 404, "User not found");
    // Accès retiré D'ABORD : en cas d'échec, le compte reste visible (et le retrait se rejoue).
    const failed = await deprovision(request, current);
    if (failed) return error(reply, 409, failed);
    await deps.users.delete(tenant, current.id);
    await audit(request, "scim.user_delete", current);
    return reply.code(204).send();
  });
}
