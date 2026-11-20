import http from "node:http";
import { localEndpoint, type LocalEndpoint } from "../security/local-endpoint.js";

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
  /** Aperçu : premières pages d'un PDF en PNG (au plus 20), et le nombre total de pages. */
  render?(pdf: Buffer): Promise<{ pages: Buffer[]; total: number }>;
}

/** Réponse bornée : texte (400 000 caractères au plus) ou pages (12 Mo de PNG, en base64). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RENDER_BYTES = 17 * 1024 * 1024;
const TIMEOUT_MS = 200_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export class UnixSocketOcr implements DocumentOcr {
  private readonly endpoint: LocalEndpoint;

  constructor(socketPath: string) {
    this.endpoint = localEndpoint(socketPath);
  }

  async recognize(bytes: Buffer, mediaType: OcrMediaType): Promise<string> {
    const body = (await this.post("/ocr", bytes, mediaType, MAX_RESPONSE_BYTES)) as { text?: unknown };
    if (typeof body.text !== "string") throw new OcrError("INVALID_RESPONSE");
    return body.text;
  }

  async render(pdf: Buffer): Promise<{ pages: Buffer[]; total: number }> {
    const body = (await this.post("/render", pdf, "application/pdf", MAX_RENDER_BYTES)) as { pages?: unknown; total?: unknown };
    if (!Array.isArray(body.pages) || typeof body.total !== "number") throw new OcrError("INVALID_RESPONSE");
    // Seulement des PNG : le service est isolé, mais sa réponse reste vérifiée.
    const pages = body.pages.filter((page): page is string => typeof page === "string").map((page) => Buffer.from(page, "base64")).filter((page) => page.subarray(0, 4).equals(PNG));
    return { pages, total: Math.max(body.total, pages.length) };
  }

  private post(path: string, bytes: Buffer, mediaType: string, limit: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          ...this.endpoint,
          path,
          method: "POST",
          headers: { "Content-Type": mediaType, "Content-Length": bytes.length },
          timeout: TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) request.destroy(new OcrError("RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            if (response.statusCode !== 200) return reject(new OcrError(String(response.statusCode)));
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
