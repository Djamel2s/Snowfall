import { detectFile, DOCX, listZipEntries, readZipEntry } from "../attachments/detect.js";
import { ExtractionError, extractText } from "../attachments/extract.js";
import { isOtherScript, isPythonScript, scriptText, SKILL_SCRIPT_TYPE } from "./scripts.js";

// Fichier d'une compétence, tel qu'il est gardé :
// - text : ce que lit le modèle (read_skill_file) ;
// - original : les octets d'origine d'un modèle binaire (Word, PDF, Excel,
//   image), copiés à côté des scripts dans le bac à sable. Jamais exécutés,
//   jamais envoyés au modèle.
// Même ajout manuel ou import zip : une seule règle.

export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Original gardé jusqu'à cette taille (au-delà : le texte extrait seulement). */
export const SKILL_ORIGINAL_MAX_BYTES = 2 * 1024 * 1024;

export type PreparedSkillFile = { mediaType: string; text: string; original?: Buffer };
export type SkillFileRejection = "script" | "unsupported" | "unreadable";

const placeholder = (name: string, kind: string) =>
  `[${kind} « ${name} » : modèle utilisable par les scripts de la compétence (contenu non lisible ici).]`;

/** Classeur Excel reconnu à son contenu (comme le .docx), pas à son extension. */
function isXlsx(bytes: Buffer) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const entries = listZipEntries(bytes);
  return Boolean(entries?.has("xl/workbook.xml") && entries.has("[Content_Types].xml"));
}

/**
 * Texte d'un classeur (chaînes partagées et valeurs des feuilles), borné : sert au
 * contrôle des données sensibles et d'aperçu au modèle. null : illisible.
 */
export function xlsxText(bytes: Buffer, maxChars = 20_000): string | null {
  const entries = listZipEntries(bytes);
  if (!entries) return null;
  const parts: string[] = [];
  let length = 0;
  const names = [...entries.keys()].filter((name) => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d{1,3}\.xml$/.test(name)).slice(0, 50);
  for (const name of names) {
    let xml: string;
    try {
      xml = readZipEntry(bytes, entries.get(name)!, 4 * 1024 * 1024).toString("utf8");
    } catch {
      return null;
    }
    for (const match of xml.matchAll(/<(?:t|v)(?:\s[^>]*)?>([^<]{0,2000})<\/(?:t|v)>/g)) {
      const value = match[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
      if (!value) continue;
      parts.push(value);
      length += value.length + 1;
      if (length >= maxChars) return parts.join("\n").slice(0, maxChars);
    }
  }
  return parts.join("\n");
}

export async function prepareSkillFile(bytes: Buffer, name: string): Promise<PreparedSkillFile | SkillFileRejection> {
  if (isOtherScript(name)) return "script";
  if (isPythonScript(name)) {
    const script = scriptText(bytes);
    return script && script.trim() ? { mediaType: SKILL_SCRIPT_TYPE, text: script } : "unreadable";
  }
  const keep = bytes.length <= SKILL_ORIGINAL_MAX_BYTES ? { original: bytes } : {};
  if (isXlsx(bytes)) {
    const cells = xlsxText(bytes);
    if (!keep.original || cells === null) return keep.original ? "unreadable" : "unsupported";
    // Aperçu des cellules : contrôlé (données sensibles) comme tout texte de compétence.
    return { mediaType: XLSX, text: cells ? `${placeholder(name, "Classeur Excel")}\n\nCellules :\n${cells}` : placeholder(name, "Classeur Excel"), ...keep };
  }

  const file = detectFile(bytes, name);
  if (!file) return "unsupported";
  // Image (logo, tampon…) : seulement comme modèle pour les scripts.
  if (file.kind === "image") return keep.original && file.mediaType !== "image/webp" ? { mediaType: file.mediaType, text: placeholder(name, "Image"), ...keep } : "unsupported";

  let text = "";
  try {
    text = (await extractText(bytes, file.mediaType)).trim();
  } catch (error) {
    if (!(error instanceof ExtractionError)) throw error;
  }
  const binary = file.mediaType === "application/pdf" || file.mediaType === DOCX;
  if (!text) return binary && keep.original ? { mediaType: file.mediaType, text: placeholder(name, "Document"), ...keep } : "unreadable";
  // Texte simple : le contenu suffit ; PDF / Word : texte pour le modèle, original pour les scripts.
  return { mediaType: file.mediaType, text, ...(binary ? keep : {}) };
}
