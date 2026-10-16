// Mesure de la qualité de recherche des bases de connaissances, par le même
// chemin de code que la production (import, découpage, embeddings, recherche
// hybride, reclassement), sur le jeu fictif ou sur VOS documents.
//
//   npm run knowledge:eval -- [options]
//     --embeddings <url>        serveur compatible OpenAI (ex. TEI : http://localhost:8401/v1)
//     --embedding-model <nom>   (défaut BAAI/bge-m3)
//     --rerank <url>            serveur de reclassement (ex. TEI : http://localhost:8402)
//     --rerank-api tei|cohere   (défaut tei)
//     --rerank-candidates <n>   passages reclassés par question (défaut 10)
//     --docs <dossier>          vos documents (PDF, Word, Markdown…)
//     --questions <fichier>     JSON : [{ "question": "...", "expected": "extrait attendu", "history": "question précédente (facultatif)" }]
//
// Rien ne sort de la machine : seuls les serveurs indiqués sont appelés.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { evalDocuments, evalQuestions, type EvalQuestion } from "../src/knowledge/eval-corpus.js";
import { EmbeddingRegistry, type EmbeddingCatalog } from "../src/knowledge/embeddings.js";
import { HttpReranker, type Reranker } from "../src/knowledge/rerank.js";
import { heuristicStandalone } from "../src/knowledge/rewrite.js";
import { KnowledgeService } from "../src/knowledge/service.js";
import { createFakeKnowledgeStore } from "../src/testing/fakes.js";
import { defaultSettings, type SettingsStore } from "../src/workspace/settings.js";

const { values } = parseArgs({
  options: {
    embeddings: { type: "string" },
    "embedding-model": { type: "string", default: "BAAI/bge-m3" },
    rerank: { type: "string" },
    "rerank-api": { type: "string", default: "tei" },
    "rerank-candidates": { type: "string", default: "10" },
    docs: { type: "string" },
    questions: { type: "string" },
  },
});

const tenant = { userId: "eval", organizationId: "eval" };
const quiet = { info: () => undefined, warn: (...args: unknown[]) => console.warn(...args), error: (...args: unknown[]) => console.error(...args) };

async function corpus(): Promise<{ documents: { name: string; bytes: Buffer }[]; questions: EvalQuestion[] }> {
  if (!values.docs) {
    return { documents: evalDocuments.map((doc) => ({ name: doc.name, bytes: Buffer.from(doc.text) })), questions: evalQuestions };
  }
  if (!values.questions) throw new Error("--docs exige --questions (fichier JSON).");
  const names = (await readdir(values.docs)).filter((name) => !name.startsWith("."));
  return {
    documents: await Promise.all(names.map(async (name) => ({ name, bytes: await readFile(join(values.docs!, name)) }))),
    questions: JSON.parse(await readFile(values.questions, "utf8")) as EvalQuestion[],
  };
}

async function evaluate(label: string, options: { embeddings: EmbeddingCatalog; reranker: Reranker | null }) {
  const { documents, questions } = await corpus();
  const embedding = options.embeddings.available().length > 0;
  const settings: SettingsStore = {
    get: async () => ({ ...defaultSettings, embeddingProvider: embedding ? "local" : null }),
    update: async (_tenant, next) => next,
    usage: async () => ({ period: "", total: { inputTokens: 0, outputTokens: 0 }, byProvider: {}, mine: { inputTokens: 0, outputTokens: 0 } }),
    usageByMember: async () => [],
    record: async () => undefined,
  };
  const store = createFakeKnowledgeStore();
  const service = new KnowledgeService({
    store,
    embeddings: options.embeddings,
    settings,
    audit: { record: async () => undefined },
    log: () => quiet as never,
    linksEnabled: false,
    reranker: options.reranker,
    rerankMinScore: 0,
    rerankCandidates: Number(values["rerank-candidates"]),
  });

  const started = performance.now();
  const base = await store.ensureBase(tenant, { kind: "agent", agentId: "eval" });
  for (const document of documents) {
    const source = await store.addSource(tenant, base.id, { kind: "file", name: document.name, mediaType: null, bytes: document.bytes });
    service.enqueue(tenant, source.id);
  }
  await service.idle();
  const failed = (await store.listSources(tenant, base.id)).filter((source) => source.status !== "ready");
  if (failed.length) console.warn(`${failed.length} document(s) non importé(s) :`, failed.map((source) => `${source.name} (${source.errorCode})`).join(", "));
  const indexing = performance.now() - started;

  const active = [{ ...(await store.findBase(tenant, { kind: "agent", agentId: "eval" }))!, label: "agent" as const }];
  const ranks: number[] = [];
  const misses: string[] = [];
  const searchStarted = performance.now();
  for (const question of questions) {
    const standalone = question.history ? heuristicStandalone([{ role: "user", content: question.history }], question.question) : null;
    const passages = await service.retrieve(tenant, active, { text: question.question, standalone });
    const rank = passages.findIndex((passage) => passage.text.includes(question.expected));
    ranks.push(rank);
    if (rank < 0 || rank > 2) misses.push(`${rank < 0 ? "absent" : `rang ${rank + 1}`} : ${question.question}`);
  }
  const n = questions.length;
  const share = (k: number) => (ranks.filter((rank) => rank >= 0 && rank < k).length / n).toFixed(2);
  const mrr = (ranks.reduce((sum, rank) => sum + (rank >= 0 ? 1 / (rank + 1) : 0), 0) / n).toFixed(2);
  const perQuery = ((performance.now() - searchStarted) / n).toFixed(0);
  console.log(`${label.padEnd(32)} R@1 ${share(1)}   R@3 ${share(3)}   R@8 ${share(8)}   MRR ${mrr}   index ${(indexing / 1000).toFixed(1)} s   ${perQuery} ms/question`);
  return misses;
}

const none: EmbeddingCatalog = { available: () => [], get: () => null };
const local: EmbeddingCatalog | null = values.embeddings
  ? new EmbeddingRegistry({
      local: {
        settings: { apiKey: "local", baseUrl: values.embeddings, maxOutputTokens: 1, timeoutMs: 120_000 },
        model: values["embedding-model"]!,
      },
    })
  : null;
const reranker = values.rerank
  ? new HttpReranker({ baseUrl: values.rerank, model: "reranker", api: values["rerank-api"] === "cohere" ? "cohere" : "tei", local: true, timeoutMs: 60_000 })
  : null;

console.log(values.docs ? `Corpus : ${values.docs}` : "Corpus : jeu d'évaluation fictif (25 questions)");
let misses = await evaluate("Mots-clés", { embeddings: none, reranker: null });
if (local) misses = await evaluate("Hybride (mots-clés + vecteurs)", { embeddings: local, reranker: null });
if (reranker) misses = await evaluate(`${local ? "Hybride" : "Mots-clés"} + reclassement (${values["rerank-candidates"]})`, { embeddings: local ?? none, reranker });
if (misses.length) console.log(`\nÉchecs (meilleure configuration) :\n  ${misses.join("\n  ")}`);
