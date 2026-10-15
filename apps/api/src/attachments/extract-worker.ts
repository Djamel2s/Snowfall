// Exécuté dans un worker thread : un fichier piégé (boucle, mémoire) ne peut
// ni bloquer ni faire tomber l'API ; le parent impose délai et plafond mémoire.
import { parentPort, workerData } from "node:worker_threads";
import { DOCX, listZipEntries, readZipEntry } from "./detect.js";

type Job = { bytes: Uint8Array; mediaType: string; maxChars: number };

const MAX_PDF_PAGES = 300;
const MAX_XML_BYTES = 25 * 1024 * 1024;

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

function docxText(bytes: Buffer, maxChars: number) {
  const entries = listZipEntries(bytes);
  const entry = entries?.get("word/document.xml");
  if (!entry) throw new Error("DOCX_INVALID");

  const xml = readZipEntry(bytes, entry, MAX_XML_BYTES).toString("utf8");
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

async function pdfText(bytes: Uint8Array, maxChars: number) {
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
  return pages.filter(Boolean).join("\n\n");
}

async function run({ bytes, mediaType, maxChars }: Job) {
  const text = mediaType === DOCX ? docxText(Buffer.from(bytes), maxChars) : await pdfText(bytes, maxChars);
  return text.replace(/\u0000/g, "").slice(0, maxChars);
}

run(workerData as Job).then(
  (text) => parentPort?.postMessage({ text }),
  (error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : "EXTRACTION_FAILED" }),
);
