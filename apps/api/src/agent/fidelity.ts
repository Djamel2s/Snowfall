import { unzipSync } from "fflate";

// Contrôle de fidélité des documents produits par le modèle (présentation,
// rapport, classeur) : un modèle « remplit » volontiers une diapositive ou un
// tableau avec des chiffres plausibles mais inventés (délais, répartitions,
// effectifs). Mesuré le 17 novembre : une consigne dans le guide ne suffit pas.
//
// On compare donc les nombres du document à ceux que le modèle a REÇUS (demande,
// pièces jointes, historique, résultats d'outils) et à ceux qu'on en déduit
// simplement : total, somme, écart, moyenne, part ou évolution en %, changement
// d'unité (k€, M€). Ce qui ne s'explique pas est signalé au modèle, qui corrige
// ou justifie. Heuristique : le fichier n'est jamais bloqué pour autant.

/** Années : jamais des données à vérifier. */
const isYear = (value: number) => Number.isInteger(value) && value >= 1900 && value <= 2100;
/** Paragraphe réduit à un petit nombre : numéro de diapositive ou de page, pastille « 1 », « 2 »… */
const MARKER = /^\s*[-+]?\d{1,2}\s*$/;
/**
 * En dessous, un écart ou une moyenne ne suffit pas (6 - 2 = « 4 h » tombe juste par hasard). Une somme de deux
 * nombres connus est admise à toute taille : « 11 incidents majeurs et critiques » (9 + 2) revenait dans
 * 2 rapports sur 5 (mesuré le 20 novembre). Limite assumée : « 8 » passe si 3 et 5 sont connus.
 */
const DERIVED_MIN = 20;
/** Changements d'unité admis (4 200 k€ = 4,2 M€). */
const SCALES = [1, 1_000, 0.001, 1_000_000, 0.000_001];
const SPACES = /[ \u00a0\u202f]/g;

export type FoundNumber = { text: string; value: number; decimals: number; percent: boolean };

/** Nombres d'un texte, formats français et anglais : « 4,2 », « 1 150 », « 73,8 % », « 0.9 », « -12 ». */
export function numbersIn(text: string, options: { markers?: boolean } = {}): FoundNumber[] {
  // markers : ignorer les paragraphes réduits à un petit nombre (côté document seulement ;
  // dans une source, une cellule « 4 » seule sur sa ligne est une donnée).
  const cleaned = text
    .split("\n")
    .filter((line) => options.markers === false || !MARKER.test(line))
    .join("\n")
    // Dates (17/11/2026, 2026-11-17) et heures (14:30) : pas des données.
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/g, " ")
    // Numérotation en tête de paragraphe : « 1. Synthèse », « 2.1 Détail », « 3) Agir » (pas « 12 h »).
    .replace(/(^|\n)\s*(?:\d+(?:\.\d+)+\.?|\d+[.)])\s+(?=\p{Lu})/gu, "$1");
  const found: FoundNumber[] = [];
  // Milliers séparés par une espace (normale, insécable, fine) ; décimales par virgule ou point.
  // Jamais collé à une lettre (T1, H2O, MP3, v2).
  const pattern =
    /(?<![\p{L}\d.,])[-\u2212+]?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?(?![\p{L}\d])(?:[ \u00a0\u202f]?%)?/gu;
  for (const match of cleaned.matchAll(pattern)) {
    const raw = match[0].trim();
    const percent = raw.endsWith("%");
    const normalized = raw.replace("%", "").replace(SPACES, "").replace("\u2212", "-").replace(",", ".");
    const value = Number(normalized);
    if (!Number.isFinite(value)) continue;
    const decimals = normalized.includes(".") ? normalized.split(".")[1]!.length : 0;
    found.push({ text: raw, value, decimals, percent });
  }
  return found;
}

/** Valeurs connues (dédoublonnées, sans signe), hors années. */
export function knownNumbers(text: string): number[] {
  const values = new Set<number>();
  for (const item of numbersIn(text, { markers: false })) if (!isYear(item.value)) values.add(Math.abs(item.value));
  return [...values].slice(0, 400);
}

/** Égal à l'arrondi près : la moitié du dernier chiffre affiché. */
const close = (value: number, decimals: number, candidate: number) => Math.abs(value - candidate) <= 0.5 * 10 ** -decimals + 1e-9;

/**
 * Nombres du document qui ne viennent pas des sources et ne s'en déduisent pas (texte affiché, sans doublon).
 * exact : admis tels quels seulement, jamais dans une déduction (la date du jour : 19 et 11 feraient
 * des moyennes ou des sommes qui tombent juste par hasard).
 */
export function unsupportedNumbers(documentText: string, known: number[], options: { exact?: number[]; limit?: number } = {}): string[] {
  const { exact = [], limit = 15 } = options;
  const total = known.reduce((sum, value) => sum + value, 0);
  // Valeurs déduites (pour les nombres d'au moins DERIVED_MIN) : total, moyennes, sommes et écarts deux à deux.
  const derived = new Set<number>([total]);
  const sums = new Set<number>();
  for (let count = 2; count <= 12; count++) derived.add(total / count);
  if (known.length <= 80) {
    for (let i = 0; i < known.length; i++) {
      for (let j = i + 1; j < known.length; j++) {
        sums.add(known[i]! + known[j]!);
        derived.add(Math.abs(known[i]! - known[j]!));
      }
    }
  }
  // Parts (a / b, b connu ou le total) et évolutions ((a - b) / b, paire connue), en fraction.
  const fractions: number[] = [];
  for (const a of known) for (const b of [...known, total]) if (b !== 0 && a <= b) fractions.push(a / b);
  if (known.length <= 80) for (const a of known) for (const b of known) if (b !== 0 && a !== b) fractions.push((a - b) / b);

  // Déductions d'au moins DERIVED_MIN (2 700 k€ → « 2,7 M€ » oui ; 6 - 2 → « 4 » non), et toute somme de deux nombres connus.
  const large = [...derived].filter((value) => value >= DERIVED_MIN).concat([...sums]);

  const unsupported = new Set<string>();
  for (const item of numbersIn(documentText)) {
    const value = Math.abs(item.value);
    if (isYear(value) || value === 0) continue;
    const scaled = (candidate: number) => SCALES.some((scale) => close(value, item.decimals, candidate * scale));
    if (known.some(scaled) || exact.includes(value)) continue;
    if (large.some(scaled)) continue;
    // Part affichée en % (« 30,4 % »), ou fraction d'une cellule au format pourcentage (0,304).
    const factor = item.percent ? 100 : value <= 1 ? 1 : 0;
    if (factor && fractions.some((fraction) => close(value, item.decimals, Math.abs(fraction) * factor))) continue;
    unsupported.add(item.text);
    if (unsupported.size >= limit) break;
  }
  return [...unsupported];
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const entities = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Texte par paragraphe d'une partie XML (ex. w:p / w:t). */
function paragraphs(xml: string, paragraph: string, run: string): string[] {
  const runs = new RegExp(`<${run}(?:\\s[^>]*)?>([^<]*)</${run}>`, "g");
  return xml
    .split(`</${paragraph}>`)
    // Entrées d'un sommaire : numéros de page calculés, pas des données.
    .filter((block) => !block.includes("PAGEREF") && !/<w:instrText[^>]*>\s*TOC\b/.test(block))
    .map((block) => [...block.matchAll(runs)].map((match) => entities(match[1]!)).join(""))
    .filter((text) => text.trim());
}

/**
 * Texte d'un document Office, un paragraphe par ligne : Word (w:t), PowerPoint
 * (a:t, et les valeurs des graphiques), Excel (textes et valeurs des cellules
 * saisies ; une cellule calculée par une formule est une déduction, ignorée).
 */
export function officeText(bytes: Uint8Array): string {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const [name, content] of Object.entries(parts)) {
    if (name === "word/document.xml") lines.push(...paragraphs(decode(content), "w:p", "w:t"));
    else if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) lines.push(...paragraphs(decode(content), "a:p", "a:t"));
    else if (/\/charts\/chart\d+\.xml$/.test(name)) {
      // Valeurs des séries (c:val), pas les catégories.
      for (const values of decode(content).matchAll(/<c:val>([\s\S]*?)<\/c:val>/g)) {
        for (const point of values[1]!.matchAll(/<c:v>([^<]*)<\/c:v>/g)) lines.push(point[1]!);
      }
    } else if (name === "xl/sharedStrings.xml") lines.push(...paragraphs(decode(content), "si", "t"));
    else if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      for (const cell of decode(content).matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        // Formule : valeur calculée. Texte partagé (t="s") : déjà lu dans sharedStrings.
        if (cell[2]!.includes("<f") || /\bt="s"/.test(cell[1]!)) continue;
        const value = /<v>([^<]*)<\/v>/.exec(cell[2]!)?.[1];
        if (value !== undefined) lines.push(value);
      }
    }
  }
  return lines.join("\n");
}
