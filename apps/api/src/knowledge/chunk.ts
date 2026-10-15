/** Taille visée d'un passage (≈ 400 tokens) et recouvrement entre passages. */
export const CHUNK_CHARS = 1_600;
export const CHUNK_OVERLAP = 200;
/** Passages par source : au-delà, le document est tronqué (et signalé). */
export const MAX_CHUNKS_PER_SOURCE = 2_000;

/**
 * Découpe un texte en passages, de préférence aux limites de paragraphes puis
 * de phrases, avec un léger recouvrement pour ne pas couper une idée en deux.
 */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length && chunks.length < MAX_CHUNKS_PER_SOURCE) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Recule jusqu'à une frontière naturelle dans la seconde moitié du passage.
      const window = clean.slice(start + Math.floor(size / 2), end);
      const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "));
      if (boundary !== -1) end = start + Math.floor(size / 2) + boundary + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export type DocumentChunk = { text: string; heading: string | null; page: number | null };

/** Saut de page laissé par l'extraction (PDF, diapositives). */
export const PAGE_BREAK = "\f";
const HEADING = /^(#{1,6})\s+(.{1,200})$/;

/**
 * Découpage qui suit la structure : un passage ne mélange pas deux sections,
 * et garde le chemin de titres (« Politique RH > Télétravail ») et la page de
 * son début. Les titres viennent de l'extraction (Markdown, styles Word,
 * balises HTML, niveaux OpenDocument), les pages des sauts de page.
 */
export function chunkDocument(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): DocumentChunk[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const paged = normalized.includes(PAGE_BREAK);
  const paragraphs: DocumentChunk[] = [];
  const stack: string[] = [];

  normalized.split(PAGE_BREAK).forEach((pageText, pageIndex) => {
    const page = paged ? pageIndex + 1 : null;
    let lines: string[] = [];
    const flush = () => {
      const body = lines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
      if (body) paragraphs.push({ text: body, heading: stack.filter(Boolean).join(" > ") || null, page });
      lines = [];
    };
    for (const line of pageText.split("\n")) {
      const heading = HEADING.exec(line.trim());
      if (heading) {
        flush();
        const level = heading[1]!.length;
        stack.length = level;
        stack[level - 1] = heading[2]!.replace(/[#*_`]+/g, "").trim();
      } else if (!line.trim()) {
        flush();
      } else {
        lines.push(line);
      }
    }
    flush();
  });

  const chunks: DocumentChunk[] = [];
  let parts: string[] = [];
  let length = 0;
  let current: DocumentChunk | null = null;

  const emit = (keepOverlap: boolean) => {
    if (!current || parts.length === 0) return;
    chunks.push({ ...current, text: parts.join("\n\n") });
    // Recouvrement : le dernier paragraphe court est repris au début du suivant.
    const last = parts[parts.length - 1]!;
    parts = keepOverlap && last.length <= overlap ? [last] : [];
    length = parts.reduce((sum, part) => sum + part.length, 0);
  };

  for (const paragraph of paragraphs) {
    if (chunks.length >= MAX_CHUNKS_PER_SOURCE) break;
    const sameSection = current && current.heading === paragraph.heading;
    if (!sameSection) {
      emit(false);
      current = { ...paragraph, text: "" };
    }
    if (paragraph.text.length > size) {
      emit(false);
      for (const piece of chunkText(paragraph.text, size, overlap)) chunks.push({ heading: paragraph.heading, page: paragraph.page, text: piece });
      current = { ...paragraph, text: "" };
      continue;
    }
    if (length + paragraph.text.length > size && parts.length > 0) {
      emit(true);
      current = { ...paragraph, text: "" };
    }
    parts.push(paragraph.text);
    length += paragraph.text.length;
  }
  emit(false);
  return chunks.slice(0, MAX_CHUNKS_PER_SOURCE);
}
