import { inflateRawSync } from "node:zlib";

export type DetectedFile =
  | { kind: "document"; mediaType: DocumentMediaType }
  | { kind: "image"; mediaType: ImageMediaType };

export type DocumentMediaType =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const LIMITS = {
  image: 5 * 1024 * 1024,
  document: 10 * 1024 * 1024,
  text: 2 * 1024 * 1024,
} as const;

const TEXT_TYPES: Record<string, DocumentMediaType> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** Nom affiché : sans chemin, sans caractères de contrôle, longueur bornée. */
export function sanitizeFileName(raw: string) {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim().slice(0, 120);
  return clean || "fichier";
}

function extension(name: string) {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name);
  return match ? match[1]!.toLowerCase() : "";
}

function startsWith(bytes: Buffer, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function isUtf8Text(bytes: Buffer) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Type réel déterminé par la signature binaire, jamais par l'extension seule
 * ni par le Content-Type annoncé. Tout le reste (SVG, HTML, exécutables,
 * archives…) est refusé. Renvoie null si le fichier n'est pas accepté.
 */
export function detectFile(bytes: Buffer, fileName: string): DetectedFile | null {
  if (bytes.length === 0) return null;

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return bytes.length <= LIMITS.image ? { kind: "image", mediaType: "image/png" } : null;
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return bytes.length <= LIMITS.image ? { kind: "image", mediaType: "image/jpeg" } : null;
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return bytes.length <= LIMITS.image ? { kind: "image", mediaType: "image/webp" } : null;
  }

  if (bytes.length > LIMITS.document) return null;

  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { kind: "document", mediaType: "application/pdf" };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const entries = listZipEntries(bytes);
    return entries?.has("word/document.xml") && entries.has("[Content_Types].xml")
      ? { kind: "document", mediaType: DOCX }
      : null;
  }

  const textType = TEXT_TYPES[extension(fileName)];
  if (textType && bytes.length <= LIMITS.text && isUtf8Text(bytes)) {
    if (textType === "application/json") {
      try {
        JSON.parse(bytes.toString("utf8"));
      } catch {
        return { kind: "document", mediaType: "text/plain" };
      }
    }
    return { kind: "document", mediaType: textType };
  }

  return null;
}

// ---- Lecture ZIP minimale (fichiers .docx) -------------------------------

type ZipEntry = { method: number; compressedSize: number; size: number; offset: number; encrypted: boolean };

const ZIP_MAX_ENTRIES = 2_000;

/** Annuaire central d'une archive ZIP ; null si l'archive est invalide, chiffrée ou ZIP64. */
export function listZipEntries(bytes: Buffer): Map<string, ZipEntry> | null {
  // Fin d'annuaire central : dans les 64 Ko + 22 octets de fin de fichier.
  const searchFrom = Math.max(0, bytes.length - 0xffff - 22);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= searchFrom; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  let pointer = bytes.readUInt32LE(eocd + 16);
  if (count > ZIP_MAX_ENTRIES || pointer + directorySize > eocd) return null;

  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index++) {
    if (pointer + 46 > bytes.length || bytes.readUInt32LE(pointer) !== 0x02014b50) return null;
    const flags = bytes.readUInt16LE(pointer + 8);
    const method = bytes.readUInt16LE(pointer + 10);
    const compressedSize = bytes.readUInt32LE(pointer + 20);
    const size = bytes.readUInt32LE(pointer + 24);
    const nameLength = bytes.readUInt16LE(pointer + 28);
    const extraLength = bytes.readUInt16LE(pointer + 30);
    const commentLength = bytes.readUInt16LE(pointer + 32);
    const offset = bytes.readUInt32LE(pointer + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) return null;

    const name = bytes.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    entries.set(name, { method, compressedSize, size, offset, encrypted: (flags & 1) === 1 });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Décompresse une entrée, avec plafond de taille (protection contre les bombes ZIP). */
export function readZipEntry(bytes: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.encrypted || entry.size > maxBytes) throw new Error("ZIP_ENTRY_REFUSED");
  if (bytes.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error("ZIP_INVALID");

  const nameLength = bytes.readUInt16LE(entry.offset + 26);
  const extraLength = bytes.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new Error("ZIP_METHOD_UNSUPPORTED");
}
