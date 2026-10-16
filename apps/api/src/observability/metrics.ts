import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";
import type { AuditLog } from "../audit/audit.js";

// Métriques Prometheus. Libellés à cardinalité bornée uniquement : modèle de
// route (jamais l'URL ni un identifiant), fournisseur, type d'événement.
// Aucune donnée d'utilisateur, d'organisation ou de contenu.

export type Metrics = ReturnType<typeof createMetrics>;

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "snowfall_" });

  return {
    registry,
    http: new Histogram({
      name: "snowfall_http_request_duration_seconds",
      help: "Durée des requêtes HTTP, par modèle de route et statut.",
      labelNames: ["method", "route", "status"] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [registry],
    }),
    generation: new Histogram({
      name: "snowfall_llm_generation_seconds",
      help: "Durée des réponses des modèles, par fournisseur et issue.",
      labelNames: ["provider", "outcome"] as const,
      buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300],
      registers: [registry],
    }),
    tokens: new Counter({
      name: "snowfall_llm_tokens_total",
      help: "Tokens consommés, par fournisseur et sens.",
      labelNames: ["provider", "direction"] as const,
      registers: [registry],
    }),
    audit: new Counter({
      name: "snowfall_audit_events_total",
      help: "Événements d'audit, par type et issue (signal de sécurité).",
      labelNames: ["event", "outcome"] as const,
      registers: [registry],
    }),
  };
}

/** Compte chaque événement d'audit avant de le transmettre au journal. */
export function countingAuditLog(inner: AuditLog, metrics: Metrics): AuditLog {
  return {
    record: (request, event) => {
      metrics.audit.inc({ event: event.eventType.slice(0, 64), outcome: event.outcome });
      return inner.record(request, event);
    },
  };
}

/**
 * Point /metrics sur un port dédié, jamais derrière nginx : joignable
 * seulement depuis le réseau interne (Prometheus). Jeton facultatif en plus.
 */
export function startMetricsServer(metrics: Metrics, options: { host: string; port: number; token?: string | undefined }): Server {
  const expected = options.token ? Buffer.from(`Bearer ${options.token}`) : null;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404).end();
      return;
    }
    if (expected) {
      const given = Buffer.from(request.headers.authorization ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        response.writeHead(401).end();
        return;
      }
    }
    metrics.registry.metrics().then(
      (body) => response.writeHead(200, { "content-type": metrics.registry.contentType, "cache-control": "no-store" }).end(body),
      () => response.writeHead(500).end(),
    );
  });
  server.listen(options.port, options.host);
  return server;
}
