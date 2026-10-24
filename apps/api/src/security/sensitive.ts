// Détection locale des données sensibles, AVANT tout envoi à un fournisseur
// externe. Déterministe (aucun modèle, aucun réseau) et explicable : chaque
// catégorie a sa règle, et les identifiants sont validés par leur clé de contrôle
// (un numéro au hasard n'en est presque jamais un).
//
// Catégories couvertes : n° de sécurité sociale (NIR), IBAN, carte bancaire, et
// informations de santé visant une personne (RGPD art. 9). Pas couvertes : les
// autres catégories de l'art. 9 (opinions, religion, orientation…), trop ambiguës
// pour une règle sans fausses alertes ; les images.

export type SensitiveCategory = "nir" | "iban" | "card" | "health";

/** Texte ramené à une forme comparable : minuscules, sans accents, apostrophes unifiées. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[’ʼ]/g, "'").toLowerCase();

// NIR : sexe, année, mois (ou 20-99 pour certains nés à l'étranger), département
// (2A/2B en Corse), commune, ordre, clé = 97 - (numéro mod 97).
const NIR = /(?<![\dA-Za-z])([1-478])[ .-]?(\d{2})[ .-]?(0[1-9]|1[0-2]|[2-9]\d)[ .-]?(\d{2}|2[AB])[ .-]?(\d{3})[ .-]?(\d{3})[ .-]?(\d{2})(?![\dA-Za-z])/gi;

/** groups : sexe, année, mois, département, commune, ordre, clé (dans cet ordre). */
function validNir(groups: string[]) {
  const [sex, year, month, department, commune, order, key] = groups;
  const corsica = department!.toUpperCase() === "2A" ? 1_000_000 : department!.toUpperCase() === "2B" ? 2_000_000 : 0;
  const digits = `${sex}${year}${month}${department!.toUpperCase().replace("2A", "19").replace("2B", "18")}${commune}${order}`;
  const number = BigInt(digits) - BigInt(corsica);
  return 97n - (number % 97n) === BigInt(key!);
}

// IBAN : pays, clé, puis les caractères suivants (groupés par 4 ou non), coupés à
// la longueur officielle du pays (registre SWIFT) : « … 189 svp » ou deux IBAN à la
// suite ne se confondent pas. Pays absent du tableau : le bloc entier (15 à 34).
const IBAN_START = /(?<![A-Z0-9])[A-Z]{2}\d{2}/g;
const IBAN_LENGTH: Record<string, number> = {
  FR: 27, MC: 27, DE: 22, BE: 16, NL: 18, LU: 20, CH: 21, LI: 21, ES: 24, IT: 27, PT: 25, AT: 20, IE: 22, GB: 22, PL: 28, SE: 24, DK: 18, FI: 18, NO: 15, GR: 27, CZ: 24, RO: 24, HU: 28, SK: 24, SI: 19, HR: 21, BG: 22, EE: 20, LV: 21, LT: 20, MT: 31, CY: 28, IS: 26,
};
const ALNUM = /[A-Z0-9]/;

function ibanChecksum(iban: string) {
  const moved = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of moved) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

/** Positions [début, fin) des IBAN valides du texte. */
function ibanSpans(text: string): [number, number][] {
  const upper = text.toUpperCase();
  const spans: [number, number][] = [];
  const start = new RegExp(IBAN_START.source, "g");
  for (let match = start.exec(upper); match; match = start.exec(upper)) {
    const length = IBAN_LENGTH[match[0].slice(0, 2)];
    let end = match.index;
    let compact = "";
    while (end < upper.length && compact.length < (length ?? 34)) {
      if (ALNUM.test(upper[end]!)) compact += upper[end++];
      else if (upper[end] === " " && ALNUM.test(upper[end + 1] ?? "")) end++;
      else break;
    }
    // Un IBAN ne se colle pas à la suite (sinon c'est un autre jeton, plus long).
    const complete = length === undefined ? compact.length >= 15 : compact.length === length && !ALNUM.test(upper[end] ?? "");
    if (complete && ibanChecksum(compact)) {
      spans.push([match.index, end]);
      start.lastIndex = end;
    }
  }
  return spans;
}

// Carte : réseaux usuels (Visa 4, Mastercard 51-55/22-27, Amex 34/37, Discover 6),
// 15 ou 16 chiffres, espaces ou tirets autorisés, clé de Luhn.
const CARD = /(?<![\d-])((?:\d[ -]?){14,15}\d)(?![\d-])/g;

function validCard(raw: string) {
  const digits = raw.replace(/[ -]/g, "");
  const network = /^4\d{15}$/.test(digits) || /^(5[1-5]|2[2-7])\d{14}$/.test(digits) || /^3[47]\d{13}$/.test(digits) || /^6(011|5\d\d)\d{12}$/.test(digits);
  if (!network) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

// Santé : un terme médical précis (pathologie, traitement, situation médicale)…
const HEALTH = new RegExp(
  "\\b(" +
    [
      "diabet\\w*", "cancer\\w*", "tumeur\\w*", "chimio\\w*", "radiotherapie", "depression", "depressi[fv]\\w*", "burn[- ]?out", "bipolaire", "schizophren\\w*",
      "vih", "seropositi\\w*", "sida", "hepatite", "ivg", "fausse couche", "grossesse", "(?:est|suis|etre|etait|tombee) enceinte", "situation de handicap", "handicape\\w*", "rqth", "invalidite",
      "arret maladie", "arret de travail", "accident du travail", "maladie professionnelle", "mi-temps therapeutique", "hospitalis\\w*", "diagnostiqu\\w*",
      "antidepresseur\\w*", "psychiatr\\w*", "addiction", "alcoolisme", "toxicomani\\w*", "epilep\\w*", "alzheimer", "parkinson", "sclerose", "autis\\w*",
      "tdah", "endometriose", "anorexi\\w*", "boulimi\\w*", "infarctus", "avc", "covid positif", "teste positif", "testee positive", "chimiotherapie", "dialyse",
      "pathologie", "maladie chronique", "affection longue duree", "medecin du travail", "inaptitude",
    ].join("|") +
    ")\\b",
);
// …ET, dans la même phrase, une personne visée (nom propre, civilité, pronom, rôle).
const PERSON_FOLDED = /\b(m\.|mme|mlle|monsieur|madame|mon|ma|mes|son|sa|ses|il|elle|lui|je|j'|moi|patient|patiente|salarie|salariee|collaborat\w*|employe|employee|agent|collegue|candidat\w*|stagiaire|enfant|fils|fille|mari|femme|conjoint\w*)\b/;
const NAME = /\b[A-ZÉÈÀ][a-zéèêëàâîïôöûüç]+(?:[- ][A-ZÉÈÀ][a-zéèêëàâîïôöûüç]+)+\b/;

function healthAboutPerson(text: string) {
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    const folded = fold(sentence);
    if (!HEALTH.test(folded)) continue;
    if (PERSON_FOLDED.test(folded) || NAME.test(sentence)) return true;
  }
  return false;
}

/**
 * Identifiants valides masqués (« ••• ») : pour ce qui s'affiche partout, comme le
 * titre d'une conversation. La santé ne se masque pas mot à mot (elle reste dans
 * le contenu, chiffré, de la conversation privée de son auteur).
 */
export function redactSensitive(text: string): string {
  let result = text;
  // De la fin vers le début : les positions restent justes.
  for (const span of identifierSpans(text).reverse()) result = `${result.slice(0, span.start)}•••${result.slice(span.end)}`;
  return result;
}

/** Positions des identifiants valides (NIR, IBAN, carte), sans chevauchement, dans l'ordre. */
export function identifierSpans(text: string): { start: number; end: number; category: Exclude<SensitiveCategory, "health"> }[] {
  const spans: { start: number; end: number; category: Exclude<SensitiveCategory, "health"> }[] = [];
  for (const match of text.matchAll(NIR)) if (validNir(match.slice(1))) spans.push({ start: match.index, end: match.index + match[0].length, category: "nir" });
  for (const match of text.matchAll(CARD)) if (validCard(match[1]!)) spans.push({ start: match.index, end: match.index + match[0].length, category: "card" });
  for (const [start, end] of ibanSpans(text)) spans.push({ start, end, category: "iban" });
  spans.sort((a, b) => a.start - b.start);
  return spans.filter((span, index) => index === 0 || span.start >= spans[index - 1]!.end);
}

/** Catégories présentes (jamais les valeurs : elles ne sortent pas de cette fonction). */
export function detectSensitive(text: string): SensitiveCategory[] {
  const found = new Set<SensitiveCategory>();
  const sample = text.slice(0, 200_000);
  for (const match of sample.matchAll(NIR)) if (validNir(match.slice(1))) found.add("nir");
  if (ibanSpans(sample).length) found.add("iban");
  for (const match of sample.matchAll(CARD)) if (validCard(match[1]!)) found.add("card");
  if (healthAboutPerson(sample)) found.add("health");
  return [...found];
}
