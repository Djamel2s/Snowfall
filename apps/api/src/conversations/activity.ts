import type { MessageSource } from "./store.js";

// Activité d'une réponse : ce que l'agent a fait (étapes, durées, ce que chaque
// étape a trouvé), gardée avec la réponse pour être relue ensuite. Jamais le
// contenu lu (pages, documents, résultats d'outils) : des libellés, des
// numéros de sources, des durées. Chiffrée comme les sources.

export type ActivityStep = {
  id: string;
  name: string;
  status: "done" | "error" | "denied";
  /** Requête, page ou action (texte du modèle ou du web : donnée, affichée en texte brut). */
  summary?: string;
  /** Sous-agent qui a fait l'étape, et l'étape de délégation qui l'a lancé. */
  agent?: string;
  parent?: string;
  startedAt?: number;
  endedAt?: number;
  /** Sources numérotées trouvées par cette étape (provenance d'une citation). */
  found?: number[];
  /** Résultat signalé comme suspect (injection) : l'agent a été averti. */
  flagged?: true;
  /** Action d'écriture (ou appel sortant) validée par l'utilisateur. */
  approved?: true;
};

export type MessageActivity = {
  startedAt: number;
  endedAt: number;
  steps: ActivityStep[];
  /** Toutes les sources consultées (citées ou non), sans leur texte. */
  consulted: MessageSource[];
};

export const ACTIVITY_MAX_STEPS = 80;
export const ACTIVITY_MAX_SOURCES = 80;
const SUMMARY_CHARS = 200;
const EXCERPT_CHARS = 280;
const LABEL = /^[A-Za-z0-9_/:.-]{1,200}$/;

/** Texte d'affichage : une ligne, sans caractères de contrôle, borné. */
export function clip(text: string | null | undefined, max: number) {
  if (!text) return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Extrait montré au survol d'une citation (texte brut, une ligne). */
export const excerptOf = (text: string | null | undefined) => clip(text, EXCERPT_CHARS);

const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);

type RawStep = {
  id: string;
  name: string;
  status: string;
  summary?: string | undefined;
  agent?: string | undefined;
  parent?: string | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  found?: number[] | undefined;
  flagged?: boolean | undefined;
  approved?: boolean | undefined;
};

/**
 * Activité à garder avec la réponse, à partir de l'avancement du run. Bornée
 * (étapes, sources, longueurs) : une réponse ne peut pas faire grossir sans fin
 * ce qui est enregistré. Rien si aucune étape (réponse directe).
 */
export function activityOf(steps: RawStep[], consulted: MessageSource[], startedAt: number | undefined, endedAt = Date.now()): MessageActivity | undefined {
  const kept: ActivityStep[] = [];
  for (const step of steps.slice(0, ACTIVITY_MAX_STEPS)) {
    if (!LABEL.test(step.id) || !LABEL.test(step.name)) continue;
    // Étape encore « en cours » à la fin (réponse arrêtée) : comptée comme interrompue.
    const status = step.status === "done" || step.status === "denied" ? step.status : "error";
    const item: ActivityStep = { id: step.id, name: step.name, status };
    const summary = clip(step.summary, SUMMARY_CHARS);
    if (summary) item.summary = summary;
    const agent = clip(step.agent, 80);
    if (agent) item.agent = agent;
    if (step.parent && LABEL.test(step.parent)) item.parent = step.parent;
    const start = time(step.startedAt);
    const end = time(step.endedAt);
    if (start) item.startedAt = start;
    if (start && end && end >= start) item.endedAt = end;
    const found = (step.found ?? []).filter((n) => Number.isInteger(n) && n > 0 && n < 1000).slice(0, 20);
    if (found.length) item.found = [...new Set(found)];
    if (step.flagged) item.flagged = true;
    if (step.approved) item.approved = true;
    kept.push(item);
  }
  if (!kept.length) return undefined;
  const first = kept.map((step) => step.startedAt).filter((value): value is number => value !== undefined);
  const start = time(startedAt) ?? (first.length ? Math.min(...first) : endedAt);
  return {
    startedAt: start,
    endedAt: Math.max(start, Math.round(endedAt)),
    steps: kept,
    consulted: consulted.slice(0, ACTIVITY_MAX_SOURCES).map((source) => {
      const { excerpt, ...rest } = source;
      const short = excerptOf(excerpt);
      return { ...rest, name: clip(source.name, 300) ?? source.sourceId.slice(0, 300), ...(short ? { excerpt: short } : {}) };
    }),
  };
}
