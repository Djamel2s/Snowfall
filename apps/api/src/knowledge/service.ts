import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { AuditLog } from "../audit/audit.js";
import { ExtractionError, extractInWorker } from "../attachments/extract.js";
import { sanitizeFileName } from "../attachments/detect.js";
import type { TenantContext } from "../db/tenant.js";
import type { ProviderId } from "../llm/types.js";
import { checkQuota, type SettingsStore } from "../workspace/settings.js";
import { KNOWLEDGE_FILE_MAX_BYTES } from "../db/schema.js";
import { chunkDocument } from "./chunk.js";
import { detectKnowledgeFile, type KnowledgeFile } from "./detect.js";
import { EmbeddingError, type Embedder, type EmbeddingCatalog } from "./embeddings.js";
import { htmlTitle } from "./html.js";
import { LinkError, safeFetch, validateUrl, type SafeFetchOptions } from "./safe-fetch.js";
import { ScannerUnavailableError, type MalwareScanner } from "../security/antivirus.js";
import type { Reranker } from "./rerank.js";
import { contextHeader, KeywordIndex, reciprocalRankFusion, vectorSearch, type SearchHit } from "./search.js";
import { KnowledgeLimitError, type KnowledgeBase, type KnowledgeStore, type LoadedBase } from "./store.js";

/** Texte extrait par source (au-delà, tronqué). */
export const MAX_SOURCE_CHARS = 2_000_000;
const EXTRACT_TIMEOUT_MS = 90_000;
export const LINK_MAX_BYTES = 15 * 1024 * 1024;
const LINK_TIMEOUT_MS = 20_000;

/** Passages injectés par réponse, et leur volume total. */
export const MAX_PASSAGES = 8;
export const PASSAGE_CHAR_BUDGET = 20_000;
/** Candidats soumis au reclassement (recherche hybride, toutes bases). */
const RERANK_CANDIDATES = 30;

const CACHE_BASES = 32;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CONCURRENCY = 2;

export type ActiveBase = KnowledgeBase & { label: "agent" | "project" };

export type Passage = {
  n: number;
  sourceId: string;
  name: string;
  url: string | null;
  base: "agent" | "project";
  /** Section (« Partie > Sous-partie ») et page du passage, si connues. */
  section: string | null;
  page: number | null;
  text: string;
};

/** Question de recherche : telle que posée, et reformulée avec l'historique. */
export type RetrievalQuery = { text: string; standalone?: string | null };

/** Source citée, conservée (chiffrée) avec la réponse. */
export type Citation = Omit<Passage, "text">;

type Job = { tenant: TenantContext; sourceId: string; request: Pick<FastifyRequest, "ip" | "id"> };

const SYSTEM_REQUEST = { ip: "system", id: "knowledge-worker" };

/** Événement d'audit hors requête HTTP : ip et id suffisent au journal. */
const asRequest = (request: Job["request"]) => request as FastifyRequest;

export class KnowledgeService {
  private readonly cache = new Map<string, { revision: number; loaded: LoadedBase; at: number; keywords: KeywordIndex }>();
  private readonly queue: Job[] = [];
  private running = 0;

  constructor(
    private readonly deps: {
      store: KnowledgeStore;
      embeddings: EmbeddingCatalog;
      settings?: SettingsStore | undefined;
      audit: AuditLog;
      /** Journal applicatif (lu à l'usage : il n'existe qu'après création de l'app). */
      log: () => FastifyBaseLogger;
      /** Interrupteur de plateforme : import de liens (KNOWLEDGE_LINKS). */
      linksEnabled: boolean;
      /** Proxy de sortie pour l'import de liens (production). */
      fetchProxy?: string | undefined;
      /** Antivirus des contenus récupérés par lien. */
      scanner?: MalwareScanner | undefined;
      /** Reclassement des candidats (optionnel). */
      reranker?: Reranker | null | undefined;
      /** Score de reclassement minimal pour garder un passage. */
      rerankMinScore?: number;
      /** Tests uniquement : résolution DNS simulée pour les liens. */
      fetchTesting?: SafeFetchOptions["testing"];
    },
  ) {}

  get store() {
    return this.deps.store;
  }

  /** Embeddings utilisés par l'organisation pour une base (null : mots-clés seuls). */
  async embedderFor(tenant: TenantContext, base: Pick<KnowledgeBase, "confidential">): Promise<Embedder | null> {
    const settings = this.deps.settings ? await this.deps.settings.get(tenant) : null;
    const provider = settings?.embeddingProvider ?? null;
    if (!provider) return null;
    // Base confidentielle : rien ne sort, jamais d'embeddings chez un tiers.
    if (base.confidential && provider !== "local") return null;
    if (settings && !settings.allowedProviders.includes(provider)) return null;
    return this.deps.embeddings.get(provider);
  }

  async linkPolicy(tenant: TenantContext) {
    const settings = this.deps.settings ? await this.deps.settings.get(tenant) : null;
    return { enabled: this.deps.linksEnabled && (settings?.linksEnabled ?? true), domains: settings?.linkDomains ?? [] };
  }

  /** Contrôle d'une URL avant import (mêmes règles que le téléchargement). */
  validateLink(raw: string, domains: string[]) {
    return validateUrl(raw, domains, this.deps.fetchTesting?.anyPort ?? false);
  }

  // ---- Import -------------------------------------------------------------

  enqueue(tenant: TenantContext, sourceId: string, request: Job["request"] = SYSTEM_REQUEST) {
    this.queue.push({ tenant: { userId: tenant.userId, organizationId: tenant.organizationId }, sourceId, request: { ip: request.ip, id: request.id } });
    this.drain();
  }

  /** Reprend les imports interrompus par un redémarrage. */
  async recover() {
    for (const job of await this.deps.store.pending()) {
      this.enqueue({ userId: job.createdBy, organizationId: job.organizationId }, job.sourceId);
    }
  }

  /** Attend la fin des imports en cours (tests, arrêt propre). */
  async idle() {
    while (this.running > 0 || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  private drain() {
    while (this.running < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      void this.process(job).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }

  private async record(job: Job, eventType: string, outcome: "success" | "failure", details: Record<string, string | number | boolean>) {
    await this.deps.audit.record(asRequest(job.request), {
      eventType,
      outcome,
      actorUserId: job.tenant.userId,
      organizationId: job.tenant.organizationId,
      targetType: "knowledge_source",
      targetId: job.sourceId,
      details,
    });
  }

  private async process(job: Job) {
    const { store } = this.deps;
    const { tenant, sourceId } = job;
    try {
      const source = await store.getSource(tenant, sourceId);
      if (!source) return;
      await store.setStatus(tenant, sourceId, "processing");

      let file: KnowledgeFile;
      let bytes: Buffer;
      let name = source.name;
      if (source.kind === "link") {
        const fetched = await this.fetchLink(tenant, source.url!);
        // Contenu téléchargé : même contrôle antivirus qu'un fichier déposé.
        if (this.deps.scanner) {
          const result = await this.deps.scanner.scan(fetched.bytes);
          if (!result.clean) {
            await this.record(job, "security.malware_detected", "failure", { signature: result.signature.slice(0, 120), kind: "link" });
            throw new SourceFailure("malware");
          }
        }
        file = fetched.file;
        bytes = fetched.bytes;
        name = fetched.name;
        await store.updateFetched(tenant, sourceId, { name, mediaType: file.mediaType, bytes });
      } else {
        const content = await store.sourceContent(tenant, sourceId);
        if (!content) return;
        const detected = detectKnowledgeFile(content.bytes, content.name, KNOWLEDGE_FILE_MAX_BYTES);
        if (typeof detected === "string") throw new SourceFailure(detected);
        file = detected;
        bytes = content.bytes;
      }

      const text =
        file.format === "text"
          ? bytes.toString("utf8").replace(/\u0000/g, "").slice(0, MAX_SOURCE_CHARS)
          : await extractInWorker(bytes, file.format, { maxChars: MAX_SOURCE_CHARS, timeoutMs: EXTRACT_TIMEOUT_MS, structure: true });
      const chunks = chunkDocument(text);
      if (chunks.length === 0) throw new SourceFailure("empty");

      // Contextual retrieval : chaque passage est vectorisé avec le nom du
      // document et sa section, pour rester trouvable hors de son contexte.
      const embedder = await this.embedderFor(tenant, source.base);
      const vectors = embedder
        ? await this.embedDocuments(tenant, embedder, chunks.map((chunk) => `${contextHeader(name, chunk.heading)}\n${chunk.text}`))
        : null;

      await store.replaceChunks(
        tenant,
        sourceId,
        chunks.map((chunk, index) => ({ text: chunk.text, heading: chunk.heading, page: chunk.page, vector: vectors?.[index] ?? null })),
        embedder?.id ?? null,
      );
      await this.record(job, "knowledge.source_ready", "success", {
        format: file.format,
        chunks: chunks.length,
        embeddings: embedder?.id ?? "keywords",
      });
    } catch (error) {
      const code = failureCode(error);
      if (code === "internal") this.deps.log().error({ err: error, sourceId }, "Échec d'import dans une base de connaissances");
      await store.setStatus(tenant, sourceId, "error", code).catch(() => undefined);
      await this.record(job, "knowledge.source_ready", "failure", { reason: code });
    }
  }

  private async fetchLink(tenant: TenantContext, url: string) {
    const policy = await this.linkPolicy(tenant);
    if (!policy.enabled) throw new SourceFailure("links_disabled");

    const fetched = await safeFetch(url, {
      maxBytes: LINK_MAX_BYTES,
      timeoutMs: LINK_TIMEOUT_MS,
      domains: policy.domains,
      proxy: this.deps.fetchProxy,
      ...(this.deps.fetchTesting ? { testing: this.deps.fetchTesting } : {}),
    });
    const final = new URL(fetched.url);
    const pathName = decodeURIComponent(final.pathname.split("/").filter(Boolean).pop() ?? "");
    const isHtml = fetched.contentType === "text/html" || fetched.contentType === "application/xhtml+xml";

    let file: KnowledgeFile;
    if (isHtml) {
      file = { format: "html", mediaType: "text/html" };
    } else {
      // Le type annoncé ne sert qu'à deviner une extension ; le contenu décide.
      const guessed = fetched.fileName ?? (pathName.includes(".") ? pathName : `${pathName || "document"}${extensionFor(fetched.contentType)}`);
      const detected = detectKnowledgeFile(fetched.bytes, guessed, LINK_MAX_BYTES);
      if (typeof detected === "string") throw new SourceFailure(detected);
      file = detected;
    }

    const title = isHtml ? htmlTitle(fetched.bytes.toString("utf8")) : null;
    const name = sanitizeFileName(title ?? fetched.fileName ?? (pathName || final.hostname));
    return { file, bytes: fetched.bytes, name };
  }

  private async embedDocuments(tenant: TenantContext, embedder: Embedder, chunks: string[]) {
    await this.admit(tenant, embedder.provider);
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < chunks.length; offset += embedder.batchSize) {
      const batch = chunks.slice(offset, offset + embedder.batchSize);
      const result = await embedder.embed(batch, "document");
      vectors.push(...result.vectors);
      await this.deps.settings?.record(tenant, embedder.provider, {
        inputTokens: result.tokens || Math.ceil(batch.join("").length / 4),
        outputTokens: 0,
      });
    }
    return vectors;
  }

  /** Les embeddings consomment le quota du fournisseur, comme les réponses. */
  private async admit(tenant: TenantContext, provider: ProviderId) {
    if (!this.deps.settings) return;
    const [settings, usage] = await Promise.all([this.deps.settings.get(tenant), this.deps.settings.usage(tenant)]);
    const decision = checkQuota(settings, usage, provider);
    if (!decision.allowed) throw new SourceFailure(decision.reason === "provider_not_allowed" ? "provider_not_allowed" : "quota_exceeded");
  }

  // ---- Recherche ----------------------------------------------------------

  private async loaded(tenant: TenantContext, base: KnowledgeBase) {
    const revision = await this.deps.store.baseRevision(tenant, base.id);
    if (revision === null) return null;
    const cached = this.cache.get(base.id);
    if (cached && cached.revision === revision && Date.now() - cached.at < CACHE_TTL_MS) {
      // Plus récemment utilisé en dernier (éviction LRU).
      this.cache.delete(base.id);
      this.cache.set(base.id, cached);
      return cached;
    }
    const loaded = await this.deps.store.load(tenant, base.id);
    if (!loaded) return null;
    const entry = { revision: loaded.base.revision, loaded, at: Date.now(), keywords: new KeywordIndex(loaded.chunks) };
    this.cache.set(base.id, entry);
    while (this.cache.size > CACHE_BASES) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }

  /** Oublie une base (suppression, changement de confidentialité). */
  forget(baseId: string) {
    this.cache.delete(baseId);
  }

  /** Reclassement autorisé pour ces bases (un service externe ne voit jamais une base confidentielle). */
  private rerankerFor(bases: KnowledgeBase[]) {
    const reranker = this.deps.reranker;
    if (!reranker) return null;
    return reranker.local || !bases.some((base) => base.confidential) ? reranker : null;
  }

  /**
   * Passages les plus pertinents des bases actives. Recherche hybride par base
   * (mots-clés sur la question et sa reformulation, vecteurs sur la
   * reformulation), fusion RRF, puis reclassement des meilleurs candidats.
   */
  async retrieve(tenant: TenantContext, bases: ActiveBase[], query: RetrievalQuery | string): Promise<Passage[]> {
    const { text, standalone } = typeof query === "string" ? { text: query, standalone: null } : query;
    const semantic = (standalone?.trim() || text).slice(0, 4_000);
    const lexical = standalone && standalone !== text ? `${standalone}\n${text}` : text;
    const candidates: { hit: SearchHit; base: ActiveBase; loaded: LoadedBase }[] = [];

    for (const base of bases) {
      const entry = await this.loaded(tenant, base);
      if (!entry || entry.loaded.chunks.length === 0) continue;

      const lists: SearchHit[][] = [entry.keywords.search(lexical, 20)];
      const embedder = await this.embedderFor(tenant, entry.loaded.base);
      if (embedder && entry.loaded.chunks.some((chunk) => chunk.model === embedder.id)) {
        try {
          await this.admit(tenant, embedder.provider);
          const result = await embedder.embed([semantic], "query");
          await this.deps.settings?.record(tenant, embedder.provider, {
            inputTokens: result.tokens || Math.ceil(semantic.length / 4),
            outputTokens: 0,
          });
          lists.push(vectorSearch(entry.loaded.chunks, { vector: result.vectors[0]!, model: embedder.id }, 20));
        } catch (error) {
          // Embeddings indisponibles : la recherche par mots-clés suffit.
          this.deps.log().warn({ err: error }, "Recherche vectorielle indisponible, mots-clés seuls");
        }
      }
      for (const hit of reciprocalRankFusion(lists, RERANK_CANDIDATES)) candidates.push({ hit, base, loaded: entry.loaded });
    }

    let ranked = candidates.sort((a, b) => b.hit.score - a.hit.score).slice(0, RERANK_CANDIDATES);
    const reranker = this.rerankerFor(ranked.map((candidate) => candidate.loaded.base));
    if (reranker && ranked.length > 1) {
      try {
        const scores = await reranker.rerank(
          semantic,
          ranked.map(({ hit, loaded }) => {
            const name = loaded.sources.get(hit.chunk.sourceId)?.name ?? "";
            return `${contextHeader(name, hit.chunk.heading)}\n${hit.chunk.text}`;
          }),
        );
        const minimum = this.deps.rerankMinScore ?? 0;
        ranked = ranked
          .map((candidate, index) => ({ ...candidate, hit: { ...candidate.hit, score: scores[index]! } }))
          .filter((candidate) => candidate.hit.score >= minimum)
          .sort((a, b) => b.hit.score - a.hit.score);
      } catch (error) {
        // Service de reclassement indisponible : l'ordre de la fusion est gardé.
        this.deps.log().warn({ err: error }, "Reclassement indisponible, ordre de la recherche hybride");
      }
    }

    const passages: Passage[] = [];
    let budget = PASSAGE_CHAR_BUDGET;
    for (const { hit, base, loaded } of ranked.slice(0, MAX_PASSAGES)) {
      if (budget <= 0) break;
      const source = loaded.sources.get(hit.chunk.sourceId);
      if (!source) continue;
      const passageText = hit.chunk.text.slice(0, budget);
      budget -= passageText.length;
      passages.push({
        n: passages.length + 1,
        sourceId: hit.chunk.sourceId,
        name: source.name,
        url: source.url,
        base: base.label,
        section: hit.chunk.heading ?? null,
        page: hit.chunk.page ?? null,
        text: passageText,
      });
    }
    return passages;
  }
}

/** Échec attendu d'un import, affiché tel quel (code court). */
class SourceFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function failureCode(error: unknown) {
  if (error instanceof SourceFailure) return error.code;
  if (error instanceof LinkError) return `link_${error.code}`;
  if (error instanceof ExtractionError) return error.message === "EXTRACTION_TIMEOUT" ? "extraction_timeout" : "unreadable";
  if (error instanceof KnowledgeLimitError) return error.code;
  if (error instanceof EmbeddingError) return "embedding_failed";
  if (error instanceof ScannerUnavailableError) return "scan_unavailable";
  return "internal";
}

function extensionFor(contentType: string) {
  const map: Record<string, string> = {
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/xml": ".xml",
    "text/xml": ".xml",
  };
  return map[contentType] ?? "";
}

const escapeAttribute = (value: string) => value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);

/** Passages injectés dans le message : des données, jamais des instructions. */
export function renderKnowledge(passages: Passage[]) {
  if (passages.length === 0) return "";
  const blocks = passages.map((passage) => {
    const attributes = [
      `id="${passage.n}"`,
      `name="${escapeAttribute(passage.name)}"`,
      ...(passage.section ? [`section="${escapeAttribute(passage.section)}"`] : []),
      ...(passage.page ? [`page="${passage.page}"`] : []),
    ].join(" ");
    return `<source ${attributes}>\n${passage.text.replace(/<\/?(knowledge|source)\b[^>]*>/gi, "")}\n</source>`;
  });
  return `<knowledge>\n${blocks.join("\n\n")}\n</knowledge>`;
}

export const citationsOf = (passages: Passage[]): Citation[] =>
  passages.map(({ text: _text, ...citation }) => citation);
