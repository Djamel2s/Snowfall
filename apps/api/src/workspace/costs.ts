import type { ProviderId } from "../llm/types.js";
import type { ToolMeter } from "./settings.js";

// Coûts en euros : calculés à partir des jetons comptés PAR MODÈLE et des appels
// d'outils, avec les tarifs saisis par l'administrateur. Rien n'est figé dans la
// base : un tarif saisi (ou corrigé) en cours de mois vaut pour tout le mois.
// Aucun tarif intégré : les prix des fournisseurs changent souvent, un tarif
// périmé afficherait de faux euros. Un modèle externe sans tarif est signalé.

/** € par million de jetons. */
export type TokenPrice = { input: number; output: number };

export type Prices = {
  /** Par modèle (« fournisseur:modèle ») ou par défaut d'un fournisseur (« fournisseur:* »). */
  models: Record<string, TokenPrice>;
  /** € par appel d'outil (ex. coût interne d'une image sur le GPU). */
  tools: Partial<Record<ToolMeter, number>>;
};

export const emptyPrices: Prices = { models: {}, tools: {} };

/** Plafonds de saisie : au-delà, une erreur de frappe (et des montants absurdes). */
export const MAX_TOKEN_PRICE = 10_000;
export const MAX_TOOL_PRICE = 1_000;
export const MAX_PRICED_MODELS = 200;
export const PRICE_KEY = /^(mistral|openai|anthropic|google|local):([\w.:/@-]{1,120}|\*)$/;

export type ModelUsage = { provider: ProviderId | "echo"; model: string; inputTokens: number; outputTokens: number };

export const modelKey = (provider: string, model: string) => `${provider}:${model || "*"}`;

/**
 * Tarif d'un modèle : le sien, sinon celui du fournisseur. Modèle local ou echo
 * sans tarif : gratuit (rien ne sort, aucun fournisseur à payer). Modèle externe
 * sans tarif : inconnu (null), signalé à l'administrateur.
 */
export function priceOf(prices: Prices, provider: string, model: string): TokenPrice | null {
  const own = model ? prices.models[`${provider}:${model}`] : undefined;
  const fallback = prices.models[`${provider}:*`];
  const price = own ?? fallback;
  if (price) return price;
  return provider === "local" || provider === "echo" ? { input: 0, output: 0 } : null;
}

export const tokenCost = (price: TokenPrice, usage: Pick<ModelUsage, "inputTokens" | "outputTokens">) =>
  (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;

export type Spend = {
  /** Total en euros (modèles sans tarif : non comptés). */
  euros: number;
  tokens: number;
  tools: number;
  /** Modèles externes utilisés sans tarif (« fournisseur:modèle »). */
  unpriced: string[];
};

export function spendOf(models: ModelUsage[], tools: Partial<Record<ToolMeter, number>>, prices: Prices): Spend {
  let tokensEuros = 0;
  const unpriced = new Set<string>();
  for (const usage of models) {
    if (usage.inputTokens + usage.outputTokens === 0) continue;
    const price = priceOf(prices, usage.provider, usage.model);
    if (price) tokensEuros += tokenCost(price, usage);
    else unpriced.add(modelKey(usage.provider, usage.model));
  }
  let toolsEuros = 0;
  for (const [meter, calls] of Object.entries(tools) as [ToolMeter, number][]) toolsEuros += (prices.tools[meter] ?? 0) * calls;
  return { euros: tokensEuros + toolsEuros, tokens: tokensEuros, tools: toolsEuros, unpriced: [...unpriced].sort() };
}

/** Tarifs lus en base : toute valeur inattendue est ignorée (jamais un prix négatif ou infini). */
export function pricesOf(value: unknown): Prices {
  const prices: Prices = { models: {}, tools: {} };
  if (typeof value !== "object" || value === null) return prices;
  const { models, tools } = value as { models?: unknown; tools?: unknown };
  const valid = (n: unknown, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max;
  if (typeof models === "object" && models !== null) {
    for (const [key, price] of Object.entries(models).slice(0, MAX_PRICED_MODELS)) {
      const { input, output } = (price ?? {}) as { input?: unknown; output?: unknown };
      if (PRICE_KEY.test(key) && valid(input, MAX_TOKEN_PRICE) && valid(output, MAX_TOKEN_PRICE)) prices.models[key] = { input, output };
    }
  }
  if (typeof tools === "object" && tools !== null) {
    for (const meter of ["code", "web", "mcp", "image"] as const) {
      const price = (tools as Record<string, unknown>)[meter];
      if (valid(price, MAX_TOOL_PRICE)) prices.tools[meter] = price;
    }
  }
  return prices;
}

/** Euros → centimes (budgets enregistrés en entiers). */
export const toCents = (euros: number) => Math.round(euros * 100);
