import OpenAI from "openai";
import type { ProviderSettings } from "../llm/types.js";
import { normalize } from "./search.js";

/** Fournisseurs capables de calculer des embeddings (Anthropic n'en propose pas). */
export const embeddingProviders = ["mistral", "openai", "google", "local"] as const;
export type EmbeddingProvider = (typeof embeddingProviders)[number];

export type EmbeddingPurpose = "document" | "query";

export interface Embedder {
  provider: EmbeddingProvider;
  model: string;
  /** "fournisseur:modèle" : deux vecteurs ne sont comparables que s'ils ont le même. */
  id: string;
  /** Textes envoyés par requête au fournisseur. */
  batchSize: number;
  embed(texts: string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<{ vectors: Float32Array[]; tokens: number }>;
}

export class EmbeddingError extends Error {
  constructor(reason: string) {
    super(`EMBEDDING_${reason}`);
  }
}

const TIMEOUT_MS = 60_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.ok) return (await response.json()) as unknown;
    // Corps d'erreur ignoré : il peut refléter le contenu envoyé.
    await response.body?.cancel();
    if (!RETRYABLE.has(response.status) || attempt >= 3 || signal?.aborted) throw new EmbeddingError(`HTTP_${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}

function vectorsFrom(values: unknown[], expected: number) {
  if (values.length !== expected) throw new EmbeddingError("INVALID_RESPONSE");
  return values.map((value) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 8192 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw new EmbeddingError("INVALID_RESPONSE");
    }
    return normalize(Float32Array.from(value as number[]));
  });
}

function mistralEmbedder(model: string, settings: ProviderSettings): Embedder {
  return {
    provider: "mistral",
    model,
    id: `mistral:${model}`,
    batchSize: 16,
    async embed(texts, _purpose, signal) {
      const data = (await postJson(
        "https://api.mistral.ai/v1/embeddings",
        { Authorization: `Bearer ${settings.apiKey}` },
        { model, input: texts },
        signal,
      )) as { data?: { embedding?: unknown; index?: number }[]; usage?: { prompt_tokens?: number } };
      const items = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return { vectors: vectorsFrom(items.map((item) => item.embedding), texts.length), tokens: data.usage?.prompt_tokens ?? 0 };
    },
  };
}

function openAiEmbedder(provider: "openai" | "local", model: string, settings: ProviderSettings): Embedder {
  const client = new OpenAI({
    apiKey: settings.apiKey,
    ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
    maxRetries: 2,
    timeout: TIMEOUT_MS,
  });
  return {
    provider,
    model,
    id: `${provider}:${model}`,
    batchSize: provider === "openai" ? 64 : 16,
    async embed(texts, _purpose, signal) {
      const response = await client.embeddings.create({ model, input: texts, encoding_format: "float" }, signal ? { signal } : {});
      const items = [...response.data].sort((a, b) => a.index - b.index);
      return { vectors: vectorsFrom(items.map((item) => item.embedding), texts.length), tokens: response.usage?.prompt_tokens ?? 0 };
    },
  };
}

function googleEmbedder(model: string, settings: ProviderSettings): Embedder {
  return {
    provider: "google",
    model,
    id: `google:${model}`,
    batchSize: 50,
    async embed(texts, purpose, signal) {
      // La clé passe en en-tête, jamais dans l'URL (journaux).
      const data = (await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
        { "x-goog-api-key": settings.apiKey },
        {
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: 768,
          })),
        },
        signal,
      )) as { embeddings?: { values?: unknown }[] };
      const tokens = Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4);
      return { vectors: vectorsFrom((data.embeddings ?? []).map((item) => item.values), texts.length), tokens };
    },
  };
}

export type EmbeddingConfig = Partial<Record<EmbeddingProvider, { settings: ProviderSettings; model: string }>>;

export interface EmbeddingCatalog {
  /** Fournisseurs configurés sur la plateforme pour les embeddings. */
  available(): EmbeddingProvider[];
  get(provider: EmbeddingProvider): Embedder | null;
}

export class EmbeddingRegistry implements EmbeddingCatalog {
  private readonly embedders = new Map<EmbeddingProvider, Embedder>();

  constructor(config: EmbeddingConfig) {
    for (const provider of embeddingProviders) {
      const entry = config[provider];
      if (!entry) continue;
      this.embedders.set(
        provider,
        provider === "mistral"
          ? mistralEmbedder(entry.model, entry.settings)
          : provider === "google"
            ? googleEmbedder(entry.model, entry.settings)
            : openAiEmbedder(provider, entry.model, entry.settings),
      );
    }
  }

  available() {
    return [...this.embedders.keys()];
  }

  get(provider: EmbeddingProvider) {
    return this.embedders.get(provider) ?? null;
  }
}
