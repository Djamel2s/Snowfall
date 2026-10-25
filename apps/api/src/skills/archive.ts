import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

// Import d'une compétence au format Anthropic : un dossier zippé avec SKILL.md
// (en-tête name / description, corps = instructions) et ses fichiers de
// référence. Lecture en flux avec des plafonds sur ce qui est RÉELLEMENT
// décompressé : les tailles annoncées par l'archive peuvent mentir (zip bomb).

export const ZIP_LIMITS = { entries: 100, fileBytes: 10 * 1024 * 1024, totalBytes: 30 * 1024 * 1024 };

export class SkillArchiveError extends Error {
  constructor(readonly code: "invalid_zip" | "too_many_entries" | "too_large" | "missing_skill_md" | "invalid_skill_md") {
    super(code);
  }
}

export type ArchiveEntry = { path: string; data: Uint8Array };

/** Décompresse en comptant chaque octet produit ; s'arrête au premier plafond dépassé. */
export function readZip(bytes: Uint8Array, limits = ZIP_LIMITS): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let total = 0;
  let count = 0;
  let failure: SkillArchiveError | null = null;
  const unzip = new Unzip((file) => {
    if (failure) return;
    count += 1;
    if (count > limits.entries) {
      failure = new SkillArchiveError("too_many_entries");
      return;
    }
    if (file.name.endsWith("/")) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) {
        failure = new SkillArchiveError("invalid_zip");
        return;
      }
      size += chunk.length;
      total += chunk.length;
      if (size > limits.fileBytes || total > limits.totalBytes) {
        failure = new SkillArchiveError("too_large");
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const data = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) {
          data.set(part, offset);
          offset += part.length;
        }
        entries.push({ path: file.name, data });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    // Par morceaux : la décompression avance au fil de la lecture (et s'arrête tôt).
    const step = 64 * 1024;
    for (let offset = 0; offset < bytes.length && !failure; offset += step) unzip.push(bytes.subarray(offset, offset + step), offset + step >= bytes.length);
  } catch {
    failure ??= new SkillArchiveError("invalid_zip");
  }
  if (failure) throw failure;
  if (count === 0) throw new SkillArchiveError("invalid_zip");
  return entries;
}

/** Chemin lisible et sûr (affiché seulement : rien n'est écrit sur disque). */
export function cleanPath(path: string) {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.join("/").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

/** En-tête YAML minimal (clé: valeur, blocs « > » et « | ») : name, description. */
export function parseSkillMarkdown(text: string) {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new SkillArchiveError("invalid_skill_md");
  const fields: Record<string, string> = {};
  const lines = match[1]!.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]!);
    if (!pair) continue;
    const [, key, raw] = pair as unknown as [string, string, string];
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!)) block.push(lines[++index]!.trim());
      fields[key] = raw.startsWith(">") ? block.join(" ") : block.join("\n");
    } else {
      fields[key] = raw.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
    }
  }
  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (!name || !description) throw new SkillArchiveError("invalid_skill_md");
  return { name, description, instructions: match[2]!.trim() };
}

/** Le SKILL.md du dossier (à la racine, ou dans l'unique dossier de premier niveau). */
export function splitSkillArchive(entries: ArchiveEntry[]) {
  // D'abord écarter les ajouts du système (macOS, fichiers cachés), puis le dossier de premier niveau.
  const kept = entries
    .map((entry) => ({ path: cleanPath(entry.path), data: entry.data }))
    .filter((entry) => entry.path && !entry.path.startsWith("__MACOSX/") && !/(^|\/)\.[^/]+$/.test(entry.path));
  const roots = new Set(kept.map((entry) => (entry.path.includes("/") ? entry.path.split("/")[0] : "")));
  const prefix = roots.size === 1 && !roots.has("") ? `${[...roots][0]}/` : "";
  const files = kept.map((entry) => ({ path: entry.path.slice(prefix.length), data: entry.data }));
  const skill = files.find((entry) => entry.path.toLowerCase() === "skill.md");
  if (!skill) throw new SkillArchiveError("missing_skill_md");
  return { skill: parseSkillMarkdown(new TextDecoder("utf-8", { fatal: false }).decode(skill.data)), others: files.filter((entry) => entry !== skill) };
}
