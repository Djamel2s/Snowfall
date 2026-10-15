import { Worker } from "node:worker_threads";
import type { DocumentMediaType } from "./detect.js";

/** Texte conservé par document (au-delà, tronqué). */
export const MAX_EXTRACTED_CHARS = 400_000;
const TIMEOUT_MS = 20_000;

export class ExtractionError extends Error {
  constructor(reason: string) {
    super(`EXTRACTION_${reason}`);
  }
}

// En développement (tsx) le worker passe par un amorçage qui charge le
// TypeScript ; une fois compilé, le .js est lancé directement.
const development = import.meta.url.endsWith(".ts");
const workerUrl = new URL(development ? "./dev-worker.mjs" : "./extract-worker.js", import.meta.url);
const entry = new URL("./extract-worker.ts", import.meta.url).href;

function inWorker(bytes: Buffer, mediaType: DocumentMediaType): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: { bytes: new Uint8Array(bytes), mediaType, maxChars: MAX_EXTRACTED_CHARS, entry },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      stderr: true,
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ExtractionError("TIMEOUT"));
    }, TIMEOUT_MS);

    worker.once("message", (message: { text?: string; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (typeof message.text === "string") resolve(message.text);
      else reject(new ExtractionError("FAILED"));
    });
    worker.once("error", () => {
      clearTimeout(timer);
      reject(new ExtractionError("FAILED"));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new ExtractionError("FAILED"));
    });
  });
}

/** Texte d'un document joint, transmis ensuite au modèle comme donnée. */
export async function extractText(bytes: Buffer, mediaType: DocumentMediaType): Promise<string> {
  if (mediaType === "application/pdf" || mediaType.endsWith("wordprocessingml.document")) {
    return inWorker(bytes, mediaType);
  }
  return bytes.toString("utf8").replace(/\u0000/g, "").slice(0, MAX_EXTRACTED_CHARS);
}
