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

/** Forme exportée vers les outils externes (journal JSON, SIEM). */
export type AuditRecord = AuditEvent & {
  timestamp: string;
  ip: string;
  requestId: string;
  source: "snowfall-api";
};

export interface AuditSink {
  publish(record: AuditRecord): void;
}

/**
 * Copie chaque événement vers des collecteurs (journal JSON, SIEM) après
 * l'écriture en base, qui reste la référence.
 */
export class FanoutAuditLog implements AuditLog {
  constructor(
    private readonly primary: AuditLog,
    private readonly sinks: AuditSink[],
  ) {}

  async record(request: FastifyRequest, event: AuditEvent) {
    await this.primary.record(request, event);
    const record: AuditRecord = {
      ...event,
      timestamp: new Date().toISOString(),
      ip: request.ip,
      requestId: request.id,
      source: "snowfall-api",
    };
    for (const sink of this.sinks) {
      try {
        sink.publish(record);
      } catch {
        // Un collecteur défaillant ne bloque jamais la requête.
      }
    }
  }
}

/** Une ligne JSON par événement sur la sortie du service (Vector, Fluent Bit…). */
export class LoggerAuditSink implements AuditSink {
  constructor(private readonly logger: FastifyBaseLogger) {}

  publish(record: AuditRecord) {
    this.logger.info({ audit: record }, "audit");
  }
}

/**
 * Envoi par lots vers un SIEM (webhook HTTPS, JSON ou Splunk HEC). File bornée :
 * en cas de panne prolongée, les plus anciens événements de la file sont
 * abandonnés (et comptés) ; la base reste complète.
 */
export class HttpAuditForwarder implements AuditSink {
  private queue: AuditRecord[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | undefined;
  private sending = false;
  private failures = 0;

  constructor(
    private readonly settings: {
      url: string;
      token?: string | undefined;
      format: "json" | "splunk-hec";
      batchSize?: number;
      maxQueue?: number;
      flushMs?: number;
    },
    private readonly logger: FastifyBaseLogger,
  ) {}

  publish(record: AuditRecord) {
    const maxQueue = this.settings.maxQueue ?? 10_000;
    if (this.queue.length >= maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(record);
    if ((this.queue.length >= (this.settings.batchSize ?? 200)) && !this.sending) void this.flush();
    else this.schedule();
  }

  private schedule() {
    if (this.timer || this.sending) return;
    // Recul exponentiel après échec (plafonné à 1 min).
    const delay = Math.min(60_000, (this.settings.flushMs ?? 2_000) * 2 ** this.failures);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref();
  }

  private body(batch: AuditRecord[]) {
    return this.settings.format === "splunk-hec"
      ? batch
          .map((record) => JSON.stringify({ time: Date.parse(record.timestamp) / 1000, sourcetype: "snowfall:audit", event: record }))
          .join("\n")
      : JSON.stringify(batch);
  }

  async flush() {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    const batch = this.queue.splice(0, this.settings.batchSize ?? 200);
    try {
      const response = await fetch(this.settings.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.settings.token
            ? { authorization: this.settings.format === "splunk-hec" ? `Splunk ${this.settings.token}` : `Bearer ${this.settings.token}` }
            : {}),
        },
        body: this.body(batch),
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`SIEM_${response.status}`);
      this.failures = 0;
      if (this.dropped > 0) {
        this.logger.warn({ dropped: this.dropped }, "Événements d'audit non transmis au SIEM (file pleine)");
        this.dropped = 0;
      }
    } catch (error) {
      this.queue.unshift(...batch);
      const overflow = this.queue.length - (this.settings.maxQueue ?? 10_000);
      if (overflow > 0) {
        this.queue.splice(0, overflow);
        this.dropped += overflow;
      }
      this.failures = Math.min(this.failures + 1, 5);
      this.logger.warn({ err: error, pending: this.queue.length }, "Échec d'envoi de l'audit au SIEM");
    } finally {
      this.sending = false;
      if (this.queue.length > 0) this.schedule();
    }
  }
}
