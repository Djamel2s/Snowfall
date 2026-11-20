import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { priceOf, pricesOf, spendOf } from "./costs.js";
import { checkBudget, checkQuota, defaultSettings, type UsageSummary } from "./settings.js";

const prices = { models: { "mistral:mistral-large-latest": { input: 2, output: 6 }, "mistral:*": { input: 0.1, output: 0.3 } }, tools: { image: 0.04 } };

describe("Coûts en euros", () => {
  it("tarif du modèle, sinon du fournisseur ; local gratuit ; externe sans tarif : inconnu", () => {
    assert.deepEqual(priceOf(prices, "mistral", "mistral-large-latest"), { input: 2, output: 6 });
    assert.deepEqual(priceOf(prices, "mistral", "mistral-small-latest"), { input: 0.1, output: 0.3 });
    // Consommation d'avant le comptage par modèle (modèle inconnu) : tarif du fournisseur.
    assert.deepEqual(priceOf(prices, "mistral", ""), { input: 0.1, output: 0.3 });
    assert.deepEqual(priceOf(prices, "local", "qwen3:8b"), { input: 0, output: 0 });
    assert.equal(priceOf(prices, "openai", "gpt-x"), null);
  });

  it("dépense : jetons et outils ; les modèles sans tarif sont signalés, jamais comptés au hasard", () => {
    const spend = spendOf(
      [
        { provider: "mistral", model: "mistral-large-latest", inputTokens: 1_000_000, outputTokens: 500_000 },
        { provider: "openai", model: "gpt-x", inputTokens: 10, outputTokens: 0 },
        { provider: "anthropic", model: "c", inputTokens: 0, outputTokens: 0 },
      ],
      { image: 25, code: 3 },
      prices,
    );
    assert.equal(spend.tokens, 5);
    assert.equal(spend.tools, 1);
    assert.equal(spend.euros, 6);
    // Sans consommation : pas signalé.
    assert.deepEqual(spend.unpriced, ["openai:gpt-x"]);
  });

  it("tarifs lus en base : négatif, infini, trop grand ou clé inconnue ignorés", () => {
    const read = pricesOf({
      models: { "mistral:*": { input: -1, output: 1 }, "pirate:x": { input: 1, output: 1 }, "openai:gpt-x": { input: 1e9, output: 1 }, "google:*": { input: 0.5, output: 1 } },
      tools: { image: Infinity, code: 0.1, other: 1 },
    });
    assert.deepEqual(read, { models: { "google:*": { input: 0.5, output: 1 } }, tools: { code: 0.1 } });
    assert.deepEqual(pricesOf(null), { models: {}, tools: {} });
  });

  it("budgets : organisation puis membre ; sans dépenses calculées, rien n'est bloqué", () => {
    const usage = (organization: number, mine: number): Pick<UsageSummary, "spend"> => ({
      spend: { organization: { euros: organization, tokens: organization, tools: 0, unpriced: [] }, mine: { euros: mine, tokens: mine, tools: 0, unpriced: [] } },
    });
    const settings = { ...defaultSettings, monthlyBudget: 100, memberMonthlyBudget: 10 };
    assert.deepEqual(checkBudget(settings, usage(50, 5)), { allowed: true });
    assert.deepEqual(checkBudget(settings, usage(100, 5)), { allowed: false, reason: "budget_exceeded" });
    assert.deepEqual(checkBudget(settings, usage(50, 10)), { allowed: false, reason: "member_budget_exceeded" });
    assert.deepEqual(checkBudget(settings, {}), { allowed: true });
    assert.deepEqual(checkBudget(defaultSettings, usage(1e9, 1e9)), { allowed: true });
    // Avant chaque réponse : après les plafonds de jetons.
    const summary: UsageSummary = { period: "2026-11-01", total: { inputTokens: 0, outputTokens: 0 }, byProvider: {}, mine: { inputTokens: 0, outputTokens: 0 }, ...usage(0, 10) };
    assert.deepEqual(checkQuota(settings, summary, "mistral"), { allowed: false, reason: "member_budget_exceeded" });
  });
});
