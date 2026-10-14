import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export type AuditOutcome = "success" | "failure" | "denied";

export type AuditEvent = {
  eventType: string;
  outcome: AuditOutcome;
  actorUserId?: string | undefined;
  organizationId?: string | undefined;
  targetType?: string | undefined;
  targetId?: string | undefined;
  // Ne jamais y mettre de contenu de message, de jeton ou de secret.
  details?: Record<string, string | number | boolean> | undefined;
};

export interface AuditLog {
  record(request: FastifyRequest, event: AuditEvent): Promise<void>;
}

/**
 * Journal applicatif en ajout seul : le rôle applicatif n'a que le droit
 * INSERT sur audit_events et un trigger interdit UPDATE/DELETE/TRUNCATE.
 */
export class PostgresAuditLog implements AuditLog {
  constructor(
    private readonly pool: Pool,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async record(request: FastifyRequest, event: AuditEvent) {
    try {
      await this.pool.query(
        `INSERT INTO audit_events
           (event_type, outcome, actor_user_id, organization_id,
            target_type, target_id, ip, request_id, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.eventType,
          event.outcome,
          event.actorUserId ?? null,
          event.organizationId ?? null,
          event.targetType ?? null,
          event.targetId ?? null,
          request.ip,
          request.id,
          event.details ?? {},
        ],
      );
    } catch (error) {
      // L'échec d'écriture d'audit est lui-même un événement de sécurité.
      this.logger.error(
        { err: error, eventType: event.eventType },
        "Échec d'écriture du journal d'audit",
      );
    }
  }
}

export const noopAuditLog: AuditLog = {
  record: async () => undefined,
};
