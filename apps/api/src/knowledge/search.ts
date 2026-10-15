// Recherche hybride en mémoire sur des passages déchiffrés : mots-clés (BM25)
// et, quand des embeddings existent, similarité cosinus ; les deux classements
// sont fusionnés (Reciprocal Rank Fusion). Rien n'est jamais confié à un index
// externe ni à la base de données.

import { stemFrench } from "./stem.js";

export type IndexedChunk = {
  id: string;
  sourceId: string;
  ordinal: number;
  text: string;
  /** Section (titres « Partie > Sous-partie ») et page d'origine, si connues. */
  heading?: string | null;
  page?: number | null;
  /**
   * En-tête contextuel indexé avec le passage (nom du document, section) :
   * un passage qui ne répète pas son sujet reste trouvable par son titre.
   */
  context?: string;
  /** Vecteur normalisé, et le modèle qui l'a produit. */
  vector: Float32Array | null;
  model: string | null;
};

export type SearchHit = { chunk: IndexedChunk; score: number };

const STOPWORDS = new Set(
  (
    "le la les un une des de du d l et ou en au aux a à est sont que qui quoi dans pour par sur avec ce cette ces se sa son ses " +
    "il elle ils elles on nous vous je tu ne pas plus y the of and or to in is are for on with as by an be this that it at from " +
    // Mots interrogatifs et verbes de question : présents dans les questions,
    // jamais discriminants dans les documents.
    "combien quel quelle quels quelles comment pourquoi quand ou est-ce puis peux peut peuvent dois doit faut faire fait " +
    "mon ma mes ton ta tes leur leurs moi toi lui t-il t-on y-a-t-il what how when where which who why can do does should"
  ).split(" "),
);

/** Mots normalisés (sans accents, minuscules), sans mots vides. */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/** Racines des mots : « chiffrement », « chiffré » et « chiffrer » se retrouvent. */
export const terms = (text: string) => tokenize(text).map(stemFrench);

/** En-tête contextuel d'un passage : document, puis section. */
export function contextHeader(sourceName: string, heading: string | null | undefined) {
  const name = sourceName.replace(/\.[a-z0-9]{1,5}$/i, "");
  if (!heading) return name;
  // Le titre principal reprend souvent le nom du document : pas de doublon.
  const path = heading.startsWith(`${name} > `) ? heading.slice(name.length + 3) : heading === name ? "" : heading;
  return path ? `${name} — ${path}` : name;
}

export function normalize(vector: Float32Array) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** Index de mots-clés BM25, construit une fois par version de la base. */
export class KeywordIndex {
  private readonly postings = new Map<string, { index: number; tf: number }[]>();
  private readonly lengths: number[] = [];
  private readonly averageLength: number;

  constructor(private readonly chunks: IndexedChunk[]) {
    chunks.forEach((chunk, index) => {
      const words = terms(chunk.context ? `${chunk.context}\n${chunk.text}` : chunk.text);
      this.lengths.push(words.length);
      const counts = new Map<string, number>();
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
      for (const [word, tf] of counts) {
        const list = this.postings.get(word) ?? [];
        list.push({ index, tf });
        this.postings.set(word, list);
      }
    });
    this.averageLength = this.lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, chunks.length);
  }

  search(query: string, limit: number): SearchHit[] {
    const k1 = 1.2;
    const b = 0.75;
    const scores = new Map<number, number>();
    for (const word of new Set(terms(query))) {
      const list = this.postings.get(word);
      if (!list) continue;
      const idf = Math.log(1 + (this.chunks.length - list.length + 0.5) / (list.length + 0.5));
      for (const { index, tf } of list) {
        const length = this.lengths[index]!;
        const score = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / (this.averageLength || 1))));
        scores.set(index, (scores.get(index) ?? 0) + score);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([index, score]) => ({ chunk: this.chunks[index]!, score }));
  }
}

/** Plus proches voisins (cosinus) parmi les passages produits par le même modèle. */
export function vectorSearch(chunks: IndexedChunk[], query: { vector: Float32Array; model: string }, limit: number, minScore = 0.2): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const chunk of chunks) {
    if (!chunk.vector || chunk.model !== query.model) continue;
    const score = dot(chunk.vector, query.vector);
    if (score >= minScore) hits.push({ chunk, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Fusion de classements : chaque liste apporte 1 / (k + rang). */
export function reciprocalRankFusion(lists: SearchHit[][], limit: number, k = 60): SearchHit[] {
  const fused = new Map<string, SearchHit>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const current = fused.get(hit.chunk.id);
      const score = 1 / (k + rank + 1);
      fused.set(hit.chunk.id, { chunk: hit.chunk, score: (current?.score ?? 0) + score });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Encodage binaire d'un vecteur (avant chiffrement). */
export const vectorToBytes = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

export function bytesToVector(bytes: Buffer) {
  if (bytes.length % 4 !== 0) throw new Error("VECTOR_INVALID");
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, copy.length / 4);
}
