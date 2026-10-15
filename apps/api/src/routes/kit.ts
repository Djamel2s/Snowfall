import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditEvent, AuditLog } from "../audit/audit.js";
import type { AuthenticatedUser } from "../auth/auth.js";

/** Outils partagés par les modules de routes. */
export type RouteKit = {
  audit: AuditLog;
  principal(request: FastifyRequest): AuthenticatedUser;
  privateResponse(reply: FastifyReply): void;
  canWrite(user: AuthenticatedUser): boolean;
  isAdmin(user: AuthenticatedUser): boolean;
  denyWrite(request: FastifyRequest, reply: FastifyReply, user: AuthenticatedUser): Promise<FastifyReply>;
  /** Événement d'audit au nom de l'utilisateur courant. */
  record(
    request: FastifyRequest,
    user: AuthenticatedUser,
    event: Omit<AuditEvent, "actorUserId" | "organizationId" | "outcome"> & { outcome?: AuditEvent["outcome"] },
  ): Promise<void>;
};

export function createRouteKit(audit: AuditLog): RouteKit {
  const kit: RouteKit = {
    audit,
    principal(request) {
      if (!request.principal) throw new Error("PRINCIPAL_MISSING");
      return request.principal;
    },
    privateResponse(reply) {
      reply.header("Cache-Control", "no-store");
      reply.header("Pragma", "no-cache");
    },
    canWrite: (user) => user.role !== "reader",
    isAdmin: (user) => user.role === "owner" || user.role === "admin",
    async denyWrite(request, reply, user) {
      await audit.record(request, {
        eventType: "authorization.write",
        outcome: "denied",
        actorUserId: user.userId,
        organizationId: user.organizationId,
        details: { role: user.role, route: request.routeOptions.url ?? "" },
      });
      return reply.code(403).send({ error: "Forbidden" });
    },
    record(request, user, event) {
      return audit.record(request, {
        outcome: "success",
        ...event,
        actorUserId: user.userId,
        organizationId: user.organizationId,
      });
    },
  };
  return kit;
}
