import http from "node:http";

// OCR local (apps/ocr) : documents numérisés lus dans l'infrastructure, sans
// service tiers. Le conteneur n'a aucun réseau ; on lui parle par socket Unix.

export type OcrMediaType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp";

export class OcrError extends Error {
  constructor(reason: string) {
    super(`OCR_${reason}`);
  }
}

export interface DocumentOcr {
  recognize(bytes: Buffer, mediaType: OcrMediaType): Promise<string>;
}

/** Réponse bornée : le service renvoie au plus 400 000 caractères. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 200_000;

export class UnixSocketOcr implements DocumentOcr {
  constructor(private readonly socketPath: string) {}

  recognize(bytes: Buffer, mediaType: OcrMediaType): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: "/ocr",
          method: "POST",
          headers: { "Content-Type": mediaType, "Content-Length": bytes.length },
          timeout: TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) request.destroy(new OcrError("RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            if (response.statusCode !== 200) return reject(new OcrError(String(response.statusCode)));
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown };
              if (typeof body.text !== "string") return reject(new OcrError("INVALID_RESPONSE"));
              resolve(body.text);
            } catch {
              reject(new OcrError("INVALID_RESPONSE"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new OcrError("TIMEOUT")));
      request.on("error", (error) => reject(error instanceof OcrError ? error : new OcrError("UNAVAILABLE")));
      request.end(bytes);
    });
  }
}

/**
 * PDF sans vraie couche texte (numérisé) : moins de 20 caractères utiles par
 * page en moyenne, ou presque rien. La page est estimée à partir du fichier.
 */
export function looksScanned(text: string, bytes: Buffer) {
  const useful = text.replace(/[\s\p{P}\p{S}]/gu, "").length;
  const pages = Math.max(1, (bytes.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length);
  return useful < 40 || useful / pages < 20;
}
