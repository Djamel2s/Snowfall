import { unzipSync } from "fflate";

// Fichiers Office produits par le code du modèle (.docx, .pptx, .xlsx) : une
// archive zip qui peut porter des macros, des objets incorporés (OLE, ActiveX)
// ou des liens vers l'extérieur ouverts par Word, PowerPoint ou Excel (modèle
// distant : fuite d'identifiants réseau ; image distante : pistage ; liaison DDE).
// Le modèle peut avoir été manipulé (injection) : avant d'être donné à
// l'utilisateur, le fichier est contrôlé. Seuls les liens hypertextes sortent.

export const OOXML_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const MAX_ENTRIES = 2_000;
const MAX_UNCOMPRESSED = 60 * 1024 * 1024;
/** Parties dangereuses, quel que soit leur nom de dossier. */
const FORBIDDEN_PART = /(^|\/)(vbaProject\.bin|vbaData\.xml)$|\/activeX\/|\/externalLinks\/|\.(bin|exe|dll|js|vbs|ps1|bat|cmd|scr|hta|jar|msi|lnk)$/i;
/** Seul objet incorporé admis : un classeur (données d'un graphique natif), contrôlé à son tour. */
const EMBEDDED = /\/embeddings\/[^/]+$/i;
const HYPERLINK = /\/relationships\/hyperlink$/;
/** Réglages d'impression (structure DEVMODE, jamais exécutée) : présents dans les modèles Office par défaut. */
const PRINTER_SETTINGS = /^(ppt|word|xl)\/printerSettings\/printerSettings\d{1,3}\.bin$/;

export type OoxmlVerdict = { ok: true } | { ok: false; reason: string };

export function checkOoxml(bytes: Uint8Array, depth = 0): OoxmlVerdict {
  let entries = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // Taille annoncée vérifiée AVANT décompression (bombe zip).
      filter: (file) => {
        entries++;
        total += file.originalSize;
        return entries <= MAX_ENTRIES && total <= MAX_UNCOMPRESSED;
      },
    });
  } catch {
    return { ok: false, reason: "not_a_package" };
  }
  if (entries > MAX_ENTRIES || total > MAX_UNCOMPRESSED) return { ok: false, reason: "too_large" };
  const names = Object.keys(files);
  if (!names.includes("[Content_Types].xml")) return { ok: false, reason: "not_a_package" };
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const types = decoder.decode(files["[Content_Types].xml"]);
  if (/macroEnabled|vbaProject|ms-office\.activeX|oleObject/i.test(types)) return { ok: false, reason: "macro" };
  for (const name of names) {
    if (FORBIDDEN_PART.test(name) && !PRINTER_SETTINGS.test(name)) return { ok: false, reason: "forbidden_part" };
    if (EMBEDDED.test(name)) {
      if (depth > 0 || !/\.xlsx$/i.test(name)) return { ok: false, reason: "embedded_object" };
      const inner = checkOoxml(files[name]!, depth + 1);
      if (!inner.ok) return inner;
    }
    if (name.endsWith(".rels")) {
      const xml = decoder.decode(files[name]);
      for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
        const tag = match[0];
        if (!/TargetMode\s*=\s*["']External["']/i.test(tag)) continue;
        const type = /Type\s*=\s*["']([^"']+)["']/.exec(tag)?.[1] ?? "";
        const target = /Target\s*=\s*["']([^"']+)["']/.exec(tag)?.[1] ?? "";
        // Lien hypertexte cliqué par l'utilisateur : admis, s'il est web ou courriel.
        if (!HYPERLINK.test(type) || !/^(https?:|mailto:)/i.test(target)) return { ok: false, reason: "external_link" };
      }
    }
    if (/\.xml$/i.test(name) && name !== "[Content_Types].xml") {
      const xml = decoder.decode(files[name]);
      // Liaisons DDE (Excel exécute une commande) et champs Word qui chargent un fichier.
      if (/<(?:\w+:)?ddeLink\b|<(?:\w+:)?oleLink\b/i.test(xml) || /\b(INCLUDETEXT|INCLUDEPICTURE|LINK|DDEAUTO|DDE)\b\s+["\\]/.test(xml)) {
        return { ok: false, reason: "dde_or_link_field" };
      }
    }
  }
  return { ok: true };
}
