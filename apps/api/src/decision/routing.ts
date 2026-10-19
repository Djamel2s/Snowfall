import type { RoutingLabel } from "./routing-cases.js";
import type { DecisionHead } from "./workshop.js";

// Routage des modèles : une question simple part vers le modèle « rapide »
// (petit, local ou bon marché), une question complexe vers le « puissant ».
// En cas de doute, toujours le puissant : on ne sacrifie pas la qualité.

/** Décideur appris (service local) : choix et confiance calibrée. */
export interface DecisionEngine {
  /** head : tête entraînée par l'atelier (sinon Laya sans entraînement). */
  decide(text: string, question: { instructions: string; options: Record<string, string> }, signal?: AbortSignal, head?: DecisionHead): Promise<{ choice: string; probabilities: Record<string, number>; confidence: number }>;
}

export const ROUTING_QUESTION = {
  instructions: "Cette demande exige-t-elle un raisonnement approfondi, une rédaction longue, du code ou l'analyse de documents ?",
  options: {
    simple: "question courte, factuelle, de conversation ou de reformulation simple",
    complexe: "analyse, comparaison, raisonnement en plusieurs étapes, code, calcul ou rédaction longue",
  },
} as const;

/**
 * Seuil sur P(complexe), choisi sur ROUTING_TRAIN puis mesuré une fois sur
 * ROUTING_TEST (22/24, aucune question simple envoyée au modèle puissant à tort).
 * Lié à la révision du modèle et à la formulation de ROUTING_QUESTION : à remesurer
 * si l'un des deux change (apps/decision/calibrate.py).
 */
export const ROUTING_COMPLEX_THRESHOLD = 0.83;

const COMPLEX = /\b(analys|compar|strat[eé]g|r[ée]dig|[ée]labor|con[cç]oi|construi|pr[ée]pare|plan(?!ning)|explique (pourquoi|en d[ée]tail|comment)|d[ée]montre|[ée]value|identifie|budget|sc[ée]nario|architect|migration|script|fonction|code|sql|python|calcul|roi\b|rentab|incoh[ée]renc|politique|r[ée]sume ce|tableau comparatif|draft|write a|design|detailed)/i;

/**
 * Heuristique (repli sans décideur appris) : longueur, pièces jointes, bloc de
 * code, vocabulaire d'analyse ou de production. Prudente : au moindre signe, « complexe ».
 */
export function heuristicRoute(text: string, context: { attachments?: number } = {}): RoutingLabel {
  if ((context.attachments ?? 0) > 0) return "complexe";
  if (text.includes("```") || text.length > 280) return "complexe";
  return COMPLEX.test(text) ? "complexe" : "simple";
}

/**
 * Décision finale, prudente : « complexe » si l'heuristique OU le décideur le dit ;
 * décideur absent, en panne ou trop lent : on s'en tient à l'heuristique.
 */
export async function routeMessage(text: string, engine: DecisionEngine | undefined, context: { attachments?: number; head?: DecisionHead | undefined } = {}, signal?: AbortSignal): Promise<{ label: RoutingLabel; source: "engine" | "trained" | "heuristic"; probability?: number }> {
  const fallback = heuristicRoute(text, context);
  if (!engine || fallback === "complexe") return { label: fallback, source: "heuristic" };
  try {
    const decision = await engine.decide(text.slice(0, 4_000), ROUTING_QUESTION, signal, context.head);
    const probability = decision.probabilities.complexe;
    if (typeof probability !== "number") return { label: fallback, source: "heuristic" };
    // Tête entraînée : son propre seuil (choisi par l'atelier), appliqué par le service.
    if (context.head) return { label: decision.choice === "complexe" ? "complexe" : "simple", source: "trained", probability };
    return { label: probability >= ROUTING_COMPLEX_THRESHOLD ? "complexe" : "simple", source: "engine", probability };
  } catch {
    return { label: fallback, source: "heuristic" };
  }
}
