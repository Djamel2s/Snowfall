import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AdminForbiddenError } from "../admin/overview.js";
import { AUDIT_EXPORT_MAX, AUDIT_PAGE, RETENTION_CHOICES, type AuditEntry, type SecurityStore } from "../admin/security.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { MemberStore } from "../workspace/members.js";
import type { RouteKit } from "./kit.js";

// Administration › Sécurité : conservation des conversations et journal
// d'audit de l'organisation (lecture, export CSV). Administrateurs seulement ;
// rôle vérifié ici ET en base ; refus et exports journalisés.

export type SecurityDependencies = { store: SecurityStore; members: MemberStore };

const categories = z
  .string()
  .max(200)
  .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(12));

const auditQuery = z
  .object({
    before: z.string().datetime({ offset: true }).optional(),
    beforeId: z.string().uuid().optional(),
    category: categories.optional(),
    problems: z.enum(["1", "0"]).optional(),
  })
  .strict()
  .refine((query) => Boolean(query.before) === Boolean(query.beforeId));

const retention = z.object({ conversationDays: z.union([z.null(), z.literal(RETENTION_CHOICES[0]), ...RETENTION_CHOICES.slice(1).map((days) => z.literal(days))]) }).strict();

/** Cellule CSV : guillemets doublés ; une valeur qui commencerait une formule (=, +, -, @) est neutralisée. */
export function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function registerSecurityRoutes(api: FastifyInstance, kit: RouteKit, deps: SecurityDependencies) {
  const denied = async (request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser, action: string) => {
    await kit.record(request, user, { eventType: `security.${action}`, outcome: "denied", details: { role: user.role } });
    return reply.code(403).send({ error: "Forbidden" });
  };

  /** Événements, avec l'adresse e-mail de leur auteur (membres de l'organisation). */
  async function withActors(user: AuthenticatedUser, entries: AuditEntry[]) {
    const emails = new Map((await deps.members.list(user)).map((member) => [member.userId, member.email]));
    return entries.map((entry) => ({ ...entry, actorEmail: entry.actorUserId ? (emails.get(entry.actorUserId) ?? null) : null }));
  }

  api.get("/admin/security/retention", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return denied(request, reply, user, "retention_view");
    return { conversationDays: await deps.store.retention(user), choices: RETENTION_CHOICES };
  });

  api.put("/admin/security/retention", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return denied(request, reply, user, "retention_update");
    const body = retention.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    if (!(await deps.store.setRetention(user, body.data.conversationDays))) return denied(request, reply, user, "retention_update");
    await kit.record(request, user, { eventType: "security.retention_update", targetType: "organization", targetId: user.organizationId, details: { conversationDays: body.data.conversationDays ?? "unlimited" } });
    return { conversationDays: body.data.conversationDays };
  });

  api.get("/admin/audit", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return denied(request, reply, user, "audit_view");
    const query = auditQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid request" });
    try {
      const entries = await deps.store.audit(user, {
        ...(query.data.before && query.data.beforeId ? { before: { at: query.data.before, id: query.data.beforeId } } : {}),
        limit: AUDIT_PAGE + 1,
        categories: query.data.category,
        problems: query.data.problems === "1",
      });
      const page = entries.slice(0, AUDIT_PAGE);
      const last = page.at(-1);
      return { events: await withActors(user, page), next: entries.length > AUDIT_PAGE && last ? { before: last.occurredAt, beforeId: last.id } : null };
    } catch (error) {
      if (error instanceof AdminForbiddenError) return denied(request, reply, user, "audit_view");
      throw error;
    }
  });

  api.get("/admin/audit/export", async (request, reply) => {
    const user = kit.principal(request);
    kit.privateResponse(reply);
    if (!kit.isAdmin(user)) return denied(request, reply, user, "audit_export");
    const query = auditQuery.safeParse(request.query);
    if (!query.success || query.data.before) return reply.code(400).send({ error: "Invalid request" });
    const entries: AuditEntry[] = [];
    try {
      let before: { at: string; id: string } | undefined;
      while (entries.length < AUDIT_EXPORT_MAX) {
        const page = await deps.store.audit(user, { before, limit: 500, categories: query.data.category, problems: query.data.problems === "1" });
        entries.push(...page);
        if (page.length < 500) break;
        before = { at: page.at(-1)!.occurredAt, id: page.at(-1)!.id };
      }
    } catch (error) {
      if (error instanceof AdminForbiddenError) return denied(request, reply, user, "audit_export");
      throw error;
    }
    const rows = (await withActors(user, entries.slice(0, AUDIT_EXPORT_MAX))).map((entry) =>
      [entry.occurredAt, entry.eventType, entry.outcome, entry.actorEmail ?? entry.actorUserId, entry.targetType, entry.targetId, entry.ip, entry.details].map(csvCell).join(","),
    );
    await kit.record(request, user, { eventType: "security.audit_export", targetType: "organization", targetId: user.organizationId, details: { rows: rows.length, categories: query.data.category?.join(",") ?? "all", problems: query.data.problems === "1" } });
    const header = ["date", "evenement", "resultat", "auteur", "cible", "identifiant", "ip", "details"].map(csvCell).join(",");
    reply.header("Content-Disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.type("text/csv; charset=utf-8").send(`﻿${[header, ...rows].join("\r\n")}\r\n`);
  });
}
