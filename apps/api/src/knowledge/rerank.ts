// Reclassement des passages candidats par un modèle « cross-encoder » (par ex.
// bge-reranker-v2-m3) servi par la plateforme : vLLM ou Infinity (API au
// format Cohere, POST /rerank) ou Text Embeddings Inference (format TEI).
// L'URL vient de la configuration, jamais d'un utilisateur.

export interface Reranker {
  id: string;
  /** Hébergé par la plateforme : utilisable pour les bases confidentielles. */
  local: boolean;
  /** Scores de pertinence, dans l'ordre des documents fournis. */
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]>;
}

export type RerankConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  api: "cohere" | "tei";
  local: boolean;
  timeoutMs: number;
};

/** Texte envoyé par passage (les modèles de reclassement lisent ~512 tokens). */
const DOCUMENT_CHARS = 2_000;

export class HttpReranker implements Reranker {
  readonly id: string;
  readonly local: boolean;

  constructor(private readonly config: RerankConfig) {
    this.id = `rerank:${config.model}`;
    this.local = config.local;
  }

  async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
    if (documents.length === 0) return [];
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const texts = documents.map((document) => document.slice(0, DOCUMENT_CHARS));
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(
        this.config.api === "tei"
          ? { query: query.slice(0, 2_000), texts, truncate: true }
          : { model: this.config.model, query: query.slice(0, 2_000), documents: texts, top_n: texts.length },
      ),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`RERANK_HTTP_${response.status}`);
    }

    const data = (await response.json()) as unknown;
    // Cohere/vLLM : { results: [{ index, relevance_score }] } ; TEI : [{ index, score }].
    const items = Array.isArray(data) ? data : (data as { results?: unknown[] }).results;
    if (!Array.isArray(items)) throw new Error("RERANK_INVALID_RESPONSE");
    const scores = new Array<number>(documents.length).fill(Number.NEGATIVE_INFINITY);
    for (const item of items as { index?: unknown; relevance_score?: unknown; score?: unknown }[]) {
      const score = typeof item.relevance_score === "number" ? item.relevance_score : item.score;
      if (typeof item.index === "number" && Number.isInteger(item.index) && item.index >= 0 && item.index < documents.length && typeof score === "number" && Number.isFinite(score)) {
        scores[item.index] = score;
      }
    }
    return scores;
  }
}
