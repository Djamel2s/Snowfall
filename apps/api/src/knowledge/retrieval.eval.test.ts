import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { extractInWorker } from "../attachments/extract.js";
import { makeZip } from "../attachments/fixtures.js";
import { createFakeKnowledgeStore } from "../testing/fakes.js";
import { chunkDocument, chunkText } from "./chunk.js";
import { evalDocuments, evalQuestions } from "./eval-corpus.js";
import { HttpReranker, type Reranker } from "./rerank.js";
import { cleanRewrite, heuristicStandalone } from "./rewrite.js";
import { contextHeader, KeywordIndex, terms, type IndexedChunk } from "./search.js";
import { KnowledgeService } from "./service.js";

type Metrics = { recall1: number; recall3: number; recall8: number; mrr: number };

/** Mesure : le passage attendu est-il dans les k premiers résultats ? */
function evaluate(options: { structured: boolean; history: boolean }): Metrics {
  const chunks: IndexedChunk[] = evalDocuments.flatMap((document, d) =>
    (options.structured ? chunkDocument(document.text, 260, 40) : chunkText(document.text, 260, 40).map((text) => ({ text, heading: null, page: null }))).map(
      (chunk, i) => ({
        id: `${d}:${i}`,
        sourceId: String(d),
        ordinal: i,
        text: chunk.text,
        heading: chunk.heading,
        context: contextHeader(document.name, chunk.heading),
        vector: null,
        model: null,
      }),
    ),
  );
  const index = new KeywordIndex(chunks);
  let recall1 = 0;
  let recall3 = 0;
  let recall8 = 0;
  let mrr = 0;
  for (const question of evalQuestions) {
    const standalone = options.history && question.history ? heuristicStandalone([{ role: "user", content: question.history }], question.question) : null;
    const query = standalone ? `${standalone}\n${question.question}` : question.question;
    const rank = index.search(query, 8).findIndex((hit) => hit.chunk.text.includes(question.expected));
    if (rank === 0) recall1++;
    if (rank >= 0 && rank < 3) recall3++;
    if (rank >= 0) {
      recall8++;
      mrr += 1 / (rank + 1);
    }
  }
  const n = evalQuestions.length;
  return { recall1: recall1 / n, recall3: recall3 / n, recall8: recall8 / n, mrr: mrr / n };
}

describe("Évaluation de la recherche (mots-clés, sans embeddings)", () => {
  it("la reformulation des questions de suivi et le découpage par section tiennent leurs seuils", (t) => {
    const baseline = evaluate({ structured: false, history: false });
    const current = evaluate({ structured: true, history: true });
    t.diagnostic(`référence      ${JSON.stringify(baseline)}`);
    t.diagnostic(`pipeline       ${JSON.stringify(current)}`);
    // Seuils mesurés sur le jeu fictif ; une régression les fait échouer.
    assert.ok(current.recall8 >= 0.85, `recall@8 ${current.recall8}`);
    assert.ok(current.recall3 >= 0.8, `recall@3 ${current.recall3}`);
    assert.ok(current.recall8 > baseline.recall8);
  });
});

describe("Racinisation, sections et pages", () => {
  it("ramène les variantes d'un mot à la même racine", () => {
    // Même chaîne que l'index : minuscules, sans accents, puis racine.
    const same = (...words: string[]) => assert.equal(new Set(words.map((word) => terms(word)[0])).size, 1, words.join(", "));
    same("chiffrement", "chiffre", "chiffrer", "chiffres");
    same("congé", "conges", "conge");
    same("sauvegarde", "sauvegardes", "sauvegarder");
    same("activement", "actif");
    same("chevaux", "cheval");
    assert.notEqual(terms("salaire")[0], terms("salle")[0]);
  });

  it("chaque passage garde son chemin de titres et sa page", () => {
    const chunks = chunkDocument("# Guide\n\n## Accès\nBadge personnel.\f## Horaires\nDe 7 h à 21 h.\n\n### Week-end\nFermé.");
    assert.deepEqual(
      chunks.map(({ heading, page }) => [heading, page]),
      [
        ["Guide > Accès", 1],
        ["Guide > Horaires", 2],
        ["Guide > Horaires > Week-end", 2],
      ],
    );
    assert.equal(contextHeader("Guide.pdf", "Guide > Horaires"), "Guide — Horaires");
  });

  it("l'extraction conserve titres Word et pages PDF pour la base de connaissances", async () => {
    const docx = makeZip({
      "word/document.xml":
        '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Sécurité</w:t></w:r></w:p>' +
        "<w:p><w:r><w:t>Le badge est personnel.</w:t></w:r></w:p></w:body></w:document>",
    });
    const text = await extractInWorker(docx, "docx", { maxChars: 10_000, timeoutMs: 20_000, structure: true });
    assert.equal(text, "# Sécurité\n\nLe badge est personnel.");
    const html = await extractInWorker(Buffer.from("<h2>Accès</h2><p>Badge</p>"), "html", { maxChars: 10_000, timeoutMs: 20_000, structure: true });
    assert.match(html, /^## Accès\n+Badge$/);
  });
});

describe("Reformulation et reclassement", () => {
  it("nettoie la reformulation du modèle et prévoit un repli", () => {
    assert.equal(cleanRewrite('Question reformulée : « Accès des stagiaires au restaurant »\nexplication'), "Accès des stagiaires au restaurant");
    assert.equal(cleanRewrite("\n\n"), null);
    assert.equal(heuristicStandalone([{ role: "user", content: "Plafond repas ?" }], "Et ailleurs ?"), "Plafond repas ?\nEt ailleurs ?");
    assert.equal(heuristicStandalone([], "Et ailleurs ?"), null);
  });

  let server: Server;
  let port = 0;
  let received: unknown;
  before(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk));
      request.on("end", () => {
        received = JSON.parse(body);
        const results = request.url === "/tei/rerank" ? [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }] : { results: [{ index: 1, relevance_score: 0.8 }, { index: 0, relevance_score: 0.3 }] };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(results));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("parle aux API de reclassement Cohere/vLLM et TEI", async () => {
    const cohere = new HttpReranker({ baseUrl: `http://127.0.0.1:${port}`, model: "bge", api: "cohere", local: true, timeoutMs: 2_000 });
    assert.deepEqual(await cohere.rerank("q", ["a", "b"]), [0.3, 0.8]);
    assert.deepEqual(received, { model: "bge", query: "q", documents: ["a", "b"], top_n: 2 });
    const tei = new HttpReranker({ baseUrl: `http://127.0.0.1:${port}/tei`, model: "bge", api: "tei", local: true, timeoutMs: 2_000 });
    assert.deepEqual(await tei.rerank("q", ["a", "b"]), [0.1, 0.9]);
  });

  async function serviceWith(reranker: Reranker, confidential: boolean) {
    const store = createFakeKnowledgeStore();
    const tenant = { userId: "u", organizationId: "o" };
    const base = await store.ensureBase(tenant, { kind: "agent", agentId: "a" });
    if (confidential) await store.setConfidential(tenant, base.id, true);
    for (const [name, text] of [["a.md", "Les congés sont validés par le manager."], ["b.md", "Les congés payés : 30 jours par an."]] as const) {
      const source = await store.addSource(tenant, base.id, { kind: "file", name, mediaType: "text/markdown", bytes: Buffer.from(text) });
      await store.replaceChunks(tenant, source.id, [{ text, vector: null }], null);
    }
    const service = new KnowledgeService({
      store,
      embeddings: { available: () => [], get: () => null },
      audit: { record: async () => undefined },
      log: () => ({ warn: () => undefined, error: () => undefined }) as never,
      linksEnabled: false,
      reranker,
      rerankMinScore: 0.2,
    });
    const active = { ...(await store.findBase(tenant, { kind: "agent", agentId: "a" }))!, label: "agent" as const };
    return service.retrieve(tenant, [active], { text: "Combien de jours de congés ?", standalone: null });
  }

  it("le reclassement réordonne, écarte l'insignifiant, et ne voit jamais une base confidentielle s'il est externe", async () => {
    const calls: string[][] = [];
    const reranker = (local: boolean): Reranker => ({
      id: "rerank:test",
      local,
      rerank: async (_query, documents) => {
        calls.push(documents);
        return documents.map((document) => (document.includes("30 jours") ? 0.9 : 0.1));
      },
    });
    const ranked = await serviceWith(reranker(true), false);
    assert.deepEqual(ranked.map((passage) => passage.name), ["b.md"]);
    // Le reclasseur lit chaque passage précédé de son en-tête (nom du document).
    assert.match(calls[0]![0]!, /^(a|b)\n/);

    calls.length = 0;
    const confidential = await serviceWith(reranker(false), true);
    assert.equal(calls.length, 0);
    assert.equal(confidential.length, 2);
  });
});
