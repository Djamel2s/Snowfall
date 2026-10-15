import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticatedUser } from "../auth/auth.js";
import { ScannerUnavailableError, type MalwareScanner } from "../security/antivirus.js";
import type { RouteKit } from "./kit.js";

/**
 * Analyse antivirus d'un fichier reçu, avant tout traitement (extraction,
 * stockage). Fichier infecté : 422 ; analyse impossible : 503 (refus, jamais
 * d'acceptation par défaut). Répond lui-même et renvoie false en cas de refus.
 */
export async function scanUpload(
  kit: RouteKit,
  scanner: MalwareScanner | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
  user: AuthenticatedUser,
  bytes: Buffer,
  target: { type: string; id: string },
): Promise<boolean> {
  if (!scanner) return true;
  try {
    const result = await scanner.scan(bytes);
    if (result.clean) return true;
    await kit.record(request, user, {
      eventType: "security.malware_detected",
      outcome: "denied",
      targetType: target.type,
      targetId: target.id,
      details: { signature: result.signature.slice(0, 120), size: bytes.length },
    });
    await reply.code(422).send({ error: "Malware detected" });
    return false;
  } catch (error) {
    if (!(error instanceof ScannerUnavailableError)) throw error;
    request.log.error({ err: error }, "Analyse antivirus impossible : fichier refusé");
    await kit.record(request, user, {
      eventType: "security.scan_unavailable",
      outcome: "failure",
      targetType: target.type,
      targetId: target.id,
      details: { reason: error.message, size: bytes.length },
    });
    await reply.code(503).send({ error: "Scanner unavailable" });
    return false;
  }
}
