import { listZipEntries, readZipEntry } from "../attachments/detect.js";

/** Extracteurs disponibles (tous exécutés dans un worker isolé, sauf le texte brut). */
export type KnowledgeFormat = "pdf" | "docx" | "xlsx" | "pptx" | "odf" | "epub" | "html" | "text";

export type KnowledgeFile =
  | { format: KnowledgeFormat; mediaType: string }
  /** Image lue par l'OCR local (seulement s'il est installé). */
  | { format: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" };

/** Fichier reconnu mais pas encore pris en charge (affiché tel quel à l'utilisateur). */
export type KnowledgeRejection = "audio_video" | "image" | "unsupported" | "too_large";

export const KNOWLEDGE_TEXT_MAX_BYTES = 5 * 1024 * 1024;

const ODF_TYPES: Record<string, string> = {
  "application/vnd.oasis.opendocument.text": "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet": "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation": "application/vnd.oasis.opendocument.presentation",
};

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: "text/plain", text: "text/plain", log: "text/plain", rst: "text/plain", tex: "text/plain",
  md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv", tsv: "text/tab-separated-values",
  json: "application/json", jsonl: "application/json", yaml: "text/yaml", yml: "text/yaml", toml: "text/plain",
  xml: "application/xml", ini: "text/plain", cfg: "text/plain", conf: "text/plain",
  html: "text/html", htm: "text/html", xhtml: "text/html",
  js: "text/plain", mjs: "text/plain", ts: "text/plain", tsx: "text/plain", jsx: "text/plain",
  py: "text/plain", java: "text/plain", kt: "text/plain", go: "text/plain", rs: "text/plain",
  c: "text/plain", h: "text/plain", cpp: "text/plain", hpp: "text/plain", cs: "text/plain",
  rb: "text/plain", php: "text/plain", sh: "text/plain", ps1: "text/plain", sql: "text/plain",
  swift: "text/plain", scala: "text/plain", r: "text/plain", vue: "text/plain", svelte: "text/plain",
  css: "text/plain", scss: "text/plain", graphql: "text/plain", proto: "text/plain", dockerfile: "text/plain",
};

function extension(name: string) {
  const match = /\.([a-z0-9]{1,12})$/i.exec(name);
  return match ? match[1]!.toLowerCase() : name.toLowerCase() === "dockerfile" ? "dockerfile" : "";
}

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);

function isUtf8Text(bytes: Buffer) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Audio, vidéo et images : reconnus pour un message clair, pas encore indexés. */
function mediaRejection(bytes: Buffer): KnowledgeRejection | null {
  if (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) ||
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
  ) {
    return "image";
  }
  if (
    startsWith(bytes, [0x49, 0x44, 0x33]) || // MP3 (ID3)
    (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) || // MP3 / AAC
    startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) || // MP4, M4A, MOV
    startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]) || // Ogg
    startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) || // WebM / MKV
    startsWith(bytes, [0x66, 0x4c, 0x61, 0x43]) || // FLAC
    (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && (startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8) || startsWith(bytes, [0x41, 0x56, 0x49, 0x20], 8)))
  ) {
    return "audio_video";
  }
  return null;
}

/**
 * Format réel déterminé par la signature binaire (et la structure interne des
 * archives), jamais par l'extension seule ni par le Content-Type annoncé.
 */
export function detectKnowledgeFile(
  bytes: Buffer,
  fileName: string,
  maxBytes: number,
  options: { images?: boolean } = {},
): KnowledgeFile | KnowledgeRejection {
  if (bytes.length === 0) return "unsupported";
  if (bytes.length > maxBytes) return "too_large";

  const media = mediaRejection(bytes);
  if (media === "image" && options.images) {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { format: "image", mediaType: "image/png" };
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { format: "image", mediaType: "image/jpeg" };
    if (startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { format: "image", mediaType: "image/webp" };
  }
  if (media) return media;

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { format: "pdf", mediaType: "application/pdf" };

  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const entries = listZipEntries(bytes);
    if (!entries) return "unsupported";
    if (entries.has("word/document.xml")) {
      return { format: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    }
    if (entries.has("xl/workbook.xml")) {
      return { format: "xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    }
    if (entries.has("ppt/presentation.xml")) {
      return { format: "pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
    }
    const mimetype = entries.get("mimetype");
    if (mimetype && mimetype.size < 100) {
      try {
        const declared = readZipEntry(bytes, mimetype, 100).toString("ascii").trim();
        if (ODF_TYPES[declared] && entries.has("content.xml")) return { format: "odf", mediaType: ODF_TYPES[declared] };
        if (declared === "application/epub+zip") return { format: "epub", mediaType: "application/epub+zip" };
      } catch {
        return "unsupported";
      }
    }
    return "unsupported";
  }

  const textType = TEXT_EXTENSIONS[extension(fileName)];
  if (textType) {
    if (bytes.length > KNOWLEDGE_TEXT_MAX_BYTES) return "too_large";
    if (!isUtf8Text(bytes)) return "unsupported";
    return { format: textType === "text/html" ? "html" : "text", mediaType: textType };
  }
  return "unsupported";
}
