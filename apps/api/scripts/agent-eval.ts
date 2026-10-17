// Évaluation des agents sur de VRAIS modèles : même boucle, mêmes outils et
// même prompt système qu'en production, sur le corpus fictif Polaris.
//
//   npm run agent:eval -- --model google:gemini-3.5-flash-lite [--model mistral:mistral-small-latest]
//     --repeat <n>        essais par cas (les modèles ne sont pas déterministes ; défaut 1)
//     --judge <p:modèle>  juge LLM pour les cas qui ont une consigne (de préférence un AUTRE modèle)
//     --only <ids>        cas à lancer, séparés par des virgules
//     --out <fichier>     enregistre les résultats (JSON) : référence pour plus tard
//     --baseline <fichier> compare à une référence et liste les régressions (code de sortie 1)
//     --embeddings <url>  embeddings locaux (sinon recherche par mots-clés)
//
// Coût : chaque cas appelle le modèle (2 à 4 fois avec les outils). Les clés
// viennent du fichier .env ; seuls les fournisseurs nommés sont appelés.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { agentCases } from "../src/evals/agent-cases.js";
import { regressions, runCase, summarize, type CaseResult, type ModelReport } from "../src/evals/agent-eval.js";
import { EmbeddingRegistry } from "../src/knowledge/embeddings.js";
import { ProviderRegistry } from "../src/llm/registry.js";
import { providerIds, type ModelSelection, type ProviderId, type ProviderSettings } from "../src/llm/types.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const { values } = parseArgs({
  options: {
    model: { type: "string", multiple: true },
    repeat: { type: "string", default: "1" },
    judge: { type: "string" },
    only: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    embeddings: { type: "string" },
  },
});

function selection(value: string): ModelSelection {
  const [provider, ...rest] = value.split(":");
  if (!providerIds.includes(provider as ProviderId) || !rest.length) throw new Error(`Modèle invalide : ${value} (attendu fournisseur:modèle)`);
  return { provider: provider as ProviderId, model: rest.join(":") };
}

const models = (values.model ?? []).map(selection);
if (!models.length) throw new Error("Indique au moins un --model fournisseur:modèle.");
const judge = values.judge ? selection(values.judge) : undefined;

// Seulement les fournisseurs utilisés, avec les mêmes limites que l'API.
const limits = { maxOutputTokens: Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? 16_000), timeoutMs: 120_000 };
const keys: Record<ProviderId, string | undefined> = {
  mistral: process.env.MISTRAL_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  local: process.env.LOCAL_LLM_BASE_URL ? (process.env.LOCAL_LLM_API_KEY ?? "local") : undefined,
};
const providers: Partial<Record<ProviderId, ProviderSettings>> = {};
for (const { provider } of [...models, ...(judge ? [judge] : [])]) {
  const apiKey = keys[provider];
  if (!apiKey) throw new Error(`Aucune clé pour ${provider} dans .env.`);
  providers[provider] = {
    apiKey,
    ...limits,
    ...(provider === "local" ? { baseUrl: process.env.LOCAL_LLM_BASE_URL, tools: process.env.LOCAL_LLM_TOOLS === "true" } : {}),
    ...(provider === "google" && process.env.GOOGLE_THINKING_LEVEL ? { thinkingLevel: process.env.GOOGLE_THINKING_LEVEL as ProviderSettings["thinkingLevel"] } : {}),
  };
}
const registry = new ProviderRegistry(providers);
const embeddings = values.embeddings
  ? new EmbeddingRegistry({ local: { settings: { apiKey: "local", baseUrl: values.embeddings, maxOutputTokens: 1, timeoutMs: 120_000 }, model: "BAAI/bge-m3" } })
  : undefined;

const only = values.only ? new Set(values.only.split(",").map((id) => id.trim())) : null;
const cases = agentCases.filter((item) => !only || only.has(item.id));
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("--repeat attend un entier entre 1 et 20.");
const pct = (passed: number, runs: number) => (runs ? `${Math.round((passed / runs) * 100)} %` : "–");

const reports: ModelReport[] = [];
const details: Record<string, CaseResult[]> = {};
console.log(`${cases.length} cas × ${repeat} essai(s) × ${models.length} modèle(s)${judge ? ` — juge : ${values.judge}` : ""}\n`);

for (const model of models) {
  const label = `${model.provider}:${model.model}`;
  const runner = registry.runner(model);
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    for (let attempt = 0; attempt < repeat; attempt++) {
      let result = await runCase(evalCase, runner, { judge: judge ? registry.runner(judge) : undefined, embeddings });
      // Quota par minute atteint : on attend, puis on rejoue le cas (deux fois au plus).
      // Mêmes formes que isRateLimit() : erreur dédiée, SDK (« 429 », « rate_limit_error »…).
      for (let retry = 1; retry <= 2 && /\b429\b|rate.?limit|too many requests|^JUDGE_/i.test(result.error ?? ""); retry++) {
        console.log(`  … quota atteint, nouvel essai de ${evalCase.id} dans ${30 * retry} s`);
        await new Promise((resolve) => setTimeout(resolve, 30_000 * retry));
        result = await runCase(evalCase, runner, { judge: judge ? registry.runner(judge) : undefined, embeddings });
      }
      results.push(result);
      const mark = result.error ? "⚠" : result.passed ? "✓" : "✗";
      const why = result.error ?? [...result.checks.filter((check) => !check.ok).map((check) => check.label + (check.detail ? ` (${check.detail})` : "")), ...(result.judge?.verdict === "fail" ? [`juge : ${result.judge.reason}`] : [])].join(" ; ");
      console.log(`  ${mark} ${label}  ${evalCase.id}${why ? `  — ${why}` : ""}`);
    }
  }
  details[label] = results;
  reports.push(summarize(label, results));
}

const categories = [...new Set(cases.map((item) => item.category))];
console.log(`\n${"Modèle".padEnd(36)} ${"Réussite".padEnd(13)} ${categories.map((category) => category.padEnd(10)).join(" ")} Jetons/cas   s/cas`);
for (const report of reports) {
  const perRun = (value: number) => Math.round(value / Math.max(1, report.runs));
  console.log(
    `${report.model.padEnd(36)} ${`${report.passed}/${report.runs} ${pct(report.passed, report.runs)}`.padEnd(13)} ` +
      categories.map((category) => pct(report.byCategory[category]?.passed ?? 0, report.byCategory[category]?.runs ?? 0).padEnd(10)).join(" ") +
      ` ${String(perRun(report.inputTokens + report.outputTokens)).padEnd(12)} ${(report.durationMs / Math.max(1, report.runs) / 1000).toFixed(1)}` +
      (report.errors ? `   (${report.errors} erreur(s) technique(s))` : ""),
  );
  const flaky = Object.entries(report.byCase).filter(([, rate]) => rate > 0 && rate < 1);
  if (flaky.length) console.log(`  instables : ${flaky.map(([id, rate]) => `${id} (${Math.round(rate * 100)} %)`).join(", ")}`);
}

if (values.out) {
  await writeFile(values.out, JSON.stringify({ date: new Date().toISOString(), repeat, reports, details }, null, 2));
  console.log(`\nRésultats enregistrés : ${values.out}`);
}

if (values.baseline) {
  const baseline = JSON.parse(await readFile(values.baseline, "utf8")) as { reports: ModelReport[] };
  let regressed = false;
  for (const report of reports) {
    const before = baseline.reports.find((item) => item.model === report.model);
    if (!before) continue;
    const lost = regressions(before, report);
    console.log(`\nRéférence ${report.model} : ${pct(before.passed, before.runs)} → ${pct(report.passed, report.runs)}`);
    for (const item of lost) console.log(`  régression : ${item.id} (${Math.round(item.after * 100)} % au lieu de 100 %)`);
    regressed ||= lost.length > 0;
  }
  if (regressed) process.exitCode = 1;
}
