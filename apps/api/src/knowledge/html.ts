// Texte lisible d'une page HTML, pour l'indexation uniquement (jamais rendu).
// Parcours linéaire, sans expression régulière à retour arrière sur le
// document : une page piégée ne peut pas bloquer le processus.

const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "head", "nav", "footer", "form", "select", "button"]);
const BLOCKS = new Set([
  "p", "div", "section", "article", "main", "aside", "header", "br", "hr", "li", "ul", "ol", "dl", "dt", "dd",
  "table", "tr", "thead", "tbody", "tfoot", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "figure",
  "figcaption", "details", "summary", "address",
]);
const CELLS = new Set(["td", "th"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  agrave: "à", acirc: "â", auml: "ä", ccedil: "ç", icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö", ugrave: "ù",
  ucirc: "û", uuml: "ü", Eacute: "É", Egrave: "È", Agrave: "À", Ccedil: "Ç", laquo: "«", raquo: "»", hellip: "…",
  mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", euro: "€", copy: "©", reg: "®", deg: "°",
  times: "×", middot: "·", bull: "•", oelig: "œ", OElig: "Œ", szlig: "ß",
};

/** Décode les entités HTML (nommées courantes et numériques). */
export function decodeEntities(text: string) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const amp = text.indexOf("&", index);
    if (amp === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, amp);
    const semi = text.indexOf(";", amp);
    if (semi === -1 || semi - amp > 12) {
      out += "&";
      index = amp + 1;
      continue;
    }
    const entity = text.slice(amp + 1, semi);
    let decoded: string | undefined;
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      decoded = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    } else {
      decoded = NAMED[entity];
    }
    if (decoded === undefined) {
      out += "&";
      index = amp + 1;
    } else {
      out += decoded;
      index = semi + 1;
    }
  }
  return out;
}

function tagName(raw: string) {
  let start = raw[0] === "/" ? 1 : 0;
  while (raw[start] === " ") start++;
  let end = start;
  while (end < raw.length && /[A-Za-z0-9:-]/.test(raw[end]!)) end++;
  return raw.slice(start, end).toLowerCase();
}

/** Titre de la page (<title>), décodé et borné. */
export function htmlTitle(html: string): string | null {
  const lower = html.slice(0, 200_000).toLowerCase();
  const start = lower.indexOf("<title");
  if (start === -1) return null;
  const open = lower.indexOf(">", start);
  const close = lower.indexOf("</title", open);
  if (open === -1 || close === -1) return null;
  const title = decodeEntities(html.slice(open + 1, close)).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 200) : null;
}

/** Texte de la page : blocs séparés par des retours à la ligne, cellules par « | ». */
export function htmlToText(html: string, maxChars = Number.POSITIVE_INFINITY, options: { headings?: boolean } = {}) {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let length = 0;
  let index = 0;

  const push = (piece: string) => {
    parts.push(piece);
    length += piece.length;
  };

  while (index < html.length && length < maxChars) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      push(decodeEntities(html.slice(index)));
      break;
    }
    if (lt > index) push(decodeEntities(html.slice(index, lt)));

    // Commentaires et déclarations.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    const raw = html.slice(lt + 1, gt);
    const name = tagName(raw);
    index = gt + 1;

    if (raw[0] !== "/" && SKIPPED.has(name) && !raw.endsWith("/")) {
      // Contenu ignoré jusqu'à la balise fermante correspondante.
      const close = lower.indexOf(`</${name}`, index);
      if (close === -1) break;
      const closeEnd = html.indexOf(">", close);
      index = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    const level = /^h([1-6])$/.exec(name)?.[1];
    if (options.headings && level && raw[0] !== "/") push(`\n${"#".repeat(Number(level))} `);
    else if (BLOCKS.has(name)) push("\n");
    else if (CELLS.has(name) && raw[0] === "/") push(" | ");
  }

  return parts
    .join("")
    .replace(/[ \t ]+/g, " ")
    .replace(/ \| ?(?=\n|$)/g, "")
    .replace(/ *\n[ \n]*/g, (match) => (match.split("\n").length > 2 ? "\n\n" : "\n"))
    .trim()
    .slice(0, maxChars);
}
