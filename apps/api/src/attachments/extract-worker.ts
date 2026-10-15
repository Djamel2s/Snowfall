// Exécuté dans un worker thread : un fichier piégé (boucle, mémoire) ne peut
// ni bloquer ni faire tomber l'API ; le parent impose délai et plafond mémoire.
import { parentPort, workerData } from "node:worker_threads";
import { listZipEntries, readZipEntry } from "./detect.js";
import { htmlToText } from "../knowledge/html.js";

export type ExtractFormat = "pdf" | "docx" | "xlsx" | "pptx" | "odf" | "epub" | "html";

/**
 * structure : titres en Markdown (#) et sauts de page (\f) conservés, pour le
 * découpage par section et les citations « p. 12 » des bases de connaissances.
 */
type Job = { bytes: Uint8Array; format: ExtractFormat; maxChars: number; structure?: boolean };

const PAGE_BREAK = "\f";

const MAX_PDF_PAGES = 1_000;
const MAX_XML_BYTES = 25 * 1024 * 1024;
const MAX_PARTS = 500;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Lit une entrée XML de l'archive (taille plafonnée : protection contre les bombes ZIP). */
function zipXml(bytes: Buffer, entries: NonNullable<ReturnType<typeof listZipEntries>>, name: string) {
  const entry = entries.get(name);
  return entry ? readZipEntry(bytes, entry, MAX_XML_BYTES).toString("utf8") : null;
}

/** Entrées numérotées (slide1.xml, sheet2.xml…) dans l'ordre naturel. */
function numbered(entries: NonNullable<ReturnType<typeof listZipEntries>>, pattern: RegExp) {
  return [...entries.keys()]
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((item) => item.match)
    .sort((a, b) => Number(a.match![1]) - Number(b.match![1]))
    .slice(0, MAX_PARTS)
    .map((item) => item.name);
}

/** Texte d'un XML bureautique : paragraphes → retour à la ligne, balises retirées. */
function xmlText(xml: string, paragraph: RegExp, maxChars: number) {
  const text = xml
    .replace(paragraph, "\n")
    .replace(/<[^>]{0,2000}>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return decodeXml(text).trim().slice(0, maxChars);
}

/** Niveau de titre d'un style Word (« Heading2 », « Titre1 », « Title »). */
function headingLevel(style: string | undefined) {
  if (!style) return 0;
  if (/^(title|titre)$/i.test(style)) return 1;
  const match = /^(?:heading|titre|berschrift|título|titolo)\s*(\d)$/i.exec(style);
  return match ? Math.min(6, Number(match[1])) : 0;
}

function docxStructured(xml: string, maxChars: number) {
  const out: string[] = [];
  let length = 0;
  for (const paragraph of xml.split("</w:p>")) {
    if (length >= maxChars) break;
    const style = /<w:pStyle w:val="([^"]{1,60})"/.exec(paragraph)?.[1];
    const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
      .map((match) => (match[1] !== undefined ? decodeXml(match[1]) : match[0] === "<w:tab/>" ? "\t" : "\n"))
      .join("")
      .trim();
    if (!text) continue;
    const level = headingLevel(style);
    const line = level ? `${"#".repeat(level)} ${text.replace(/\s+/g, " ")}` : text;
    out.push(line);
    length += line.length;
  }
  return out.join("\n\n");
}

function docxText(bytes: Buffer, maxChars: number, structure = false) {
  const entries = listZipEntries(bytes);
  const xml = entries && zipXml(bytes, entries, "word/document.xml");
  if (!xml) throw new Error("DOCX_INVALID");
  if (structure) return docxStructured(xml, maxChars);

  const parts: string[] = [];
  let length = 0;
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:tab\/>|<w:br\/>/g;

  for (let match = token.exec(xml); match && length < maxChars; match = token.exec(xml)) {
    const piece = match[1] !== undefined ? decodeXml(match[1]) : match[0] === "<w:tab/>" ? "\t" : "\n";
    parts.push(piece);
    length += piece.length;
  }
  return parts.join("");
}

function xlsxText(bytes: Buffer, maxChars: number) {
  const entries = listZipEntries(bytes);
  if (!entries) throw new Error("XLSX_INVALID");

  const shared: string[] = [];
  const sharedXml = zipXml(bytes, entries, "xl/sharedStrings.xml");
  if (sharedXml) {
    for (const item of sharedXml.split("</si>")) {
      const texts = [...item.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((match) => decodeXml(match[1] ?? ""));
      shared.push(texts.join(""));
    }
  }

  const names = [...(zipXml(bytes, entries, "xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) =>
    decodeXml(match[1] ?? ""),
  );
  const sheets = numbered(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/);
  const out: string[] = [];
  let length = 0;

  sheets.forEach((sheet, index) => {
    if (length >= maxChars) return;
    const xml = zipXml(bytes, entries, sheet) ?? "";
    out.push(`## ${names[index] ?? `Feuille ${index + 1}`}`);
    for (const row of xml.split("</row>")) {
      if (length >= maxChars) break;
      const cells: string[] = [];
      for (const cell of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1] ?? "";
        const body = cell[2] ?? "";
        const value = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        const inline = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((match) => match[1]).join("");
        const text = /\bt="s"/.test(attributes) && value !== undefined ? (shared[Number(value)] ?? "") : decodeXml(inline || value || "");
        cells.push(text.trim());
      }
      const line = cells.join(" | ").replace(/( \| )+$/, "");
      if (line.replace(/[ |]/g, "")) {
        out.push(line);
        length += line.length;
      }
    }
  });
  return out.join("\n");
}

function pptxText(bytes: Buffer, maxChars: number, structure = false) {
  const entries = listZipEntries(bytes);
  if (!entries) throw new Error("PPTX_INVALID");
  const out: string[] = [];
  let length = 0;
  for (const [index, slide] of numbered(entries, /^ppt\/slides\/slide(\d+)\.xml$/).entries()) {
    if (length >= maxChars) break;
    const text = xmlText(zipXml(bytes, entries, slide) ?? "", /<\/a:p>/g, maxChars);
    out.push(`## Diapositive ${index + 1}\n${text}`);
    length += text.length;
  }
  return out.join(structure ? `\n${PAGE_BREAK}` : "\n\n");
}

function odfText(bytes: Buffer, maxChars: number, structure = false) {
  const entries = listZipEntries(bytes);
  const xml = entries && zipXml(bytes, entries, "content.xml");
  if (!xml) throw new Error("ODF_INVALID");
  const titled = structure
    ? xml.replace(/<text:h\b[^>]{0,500}?text:outline-level="(\d)"[^>]{0,500}>/g, (_match, level: string) => `\n${"#".repeat(Math.min(6, Number(level)))} `)
    : xml;
  return xmlText(
    titled.replace(/<text:tab\/>/g, "\t").replace(/<text:s(?:\s[^>]*)?\/>/g, " ").replace(/<\/table:table-cell>/g, " | "),
    /<\/text:p>|<\/text:h>|<text:line-break\/>|<\/table:table-row>/g,
    maxChars,
  );
}

function epubText(bytes: Buffer, maxChars: number, structure = false) {
  const entries = listZipEntries(bytes);
  if (!entries) throw new Error("EPUB_INVALID");

  // Ordre de lecture : le « spine » du paquet OPF, sinon l'ordre des fichiers.
  let chapters: string[] = [];
  const rootPath = /full-path="([^"]+)"/.exec(zipXml(bytes, entries, "META-INF/container.xml") ?? "")?.[1];
  const opf = rootPath ? zipXml(bytes, entries, rootPath) : null;
  if (rootPath && opf) {
    const base = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/") + 1) : "";
    const manifest = new Map(
      [...opf.matchAll(/<item\b[^>]*>/g)].map((item) => [
        /\bid="([^"]+)"/.exec(item[0])?.[1] ?? "",
        /\bhref="([^"]+)"/.exec(item[0])?.[1] ?? "",
      ]),
    );
    chapters = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)]
      .map((ref) => manifest.get(ref[1] ?? ""))
      .filter((href): href is string => !!href)
      .map((href) => base + decodeURIComponent(href.split("#")[0] ?? ""));
  }
  if (chapters.length === 0) chapters = [...entries.keys()].filter((name) => /\.x?html?$/i.test(name)).sort();

  const out: string[] = [];
  let length = 0;
  for (const chapter of chapters.slice(0, MAX_PARTS)) {
    if (length >= maxChars) break;
    const html = zipXml(bytes, entries, chapter);
    if (!html) continue;
    const text = htmlToText(html, maxChars - length, { headings: structure });
    out.push(text);
    length += text.length;
  }
  return out.join("\n\n");
}

async function pdfText(bytes: Uint8Array, maxChars: number, structure = false) {
  // pdfjs requiert Promise.withResolvers (Node 22+) ; le projet cible Node 24,
  // ce repli ne sert qu'aux postes de développement plus anciens.
  if (!("withResolvers" in Promise)) {
    Object.assign(Promise, {
      withResolvers<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((ok, ko) => {
          resolve = ok;
          reject = ko;
        });
        return { promise, resolve, reject };
      },
    });
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs 6 n'évalue plus jamais de code issu du PDF (le compilateur par
  // new Function, cause de CVE-2024-4367, a été retiré) ; pas de rendu ni de
  // polices : seul le texte est lu.
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const document = await task.promise;

  const pages: string[] = [];
  let length = 0;
  for (let number = 1; number <= Math.min(document.numPages, MAX_PDF_PAGES) && length < maxChars; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
    }
    pages.push(text.trim());
    length += text.length;
    page.cleanup();
  }
  await task.destroy();
  // Pages vides gardées en mode structure : la numérotation reste exacte.
  return structure ? pages.join(`\n${PAGE_BREAK}`) : pages.filter(Boolean).join("\n\n");
}

async function run({ bytes, format, maxChars, structure = false }: Job) {
  const buffer = Buffer.from(bytes);
  const text =
    format === "pdf" ? await pdfText(bytes, maxChars, structure)
    : format === "docx" ? docxText(buffer, maxChars, structure)
    : format === "xlsx" ? xlsxText(buffer, maxChars)
    : format === "pptx" ? pptxText(buffer, maxChars, structure)
    : format === "odf" ? odfText(buffer, maxChars, structure)
    : format === "epub" ? epubText(buffer, maxChars, structure)
    : htmlToText(buffer.toString("utf8"), maxChars, { headings: structure });
  return text.replace(/\u0000/g, "").slice(0, maxChars);
}

run(workerData as Job).then(
  (text) => parentPort?.postMessage({ text }),
  (error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : "EXTRACTION_FAILED" }),
);
