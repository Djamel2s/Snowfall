import type { ChatTurn } from "../graph/chat-graph.js";
import type { AgentTool, ToolPreview } from "./tools.js";

// « Règle de deux » : un agent ne doit pas, sans accord humain, cumuler les
// trois capacités suivantes dans une même réponse :
//   1. avoir lu un contenu non fiable (page web, résultat MCP, pièce jointe) ;
//   2. avoir lu des données internes (base de connaissances, pièce jointe) ;
//   3. envoyer quelque chose vers l'extérieur (recherche web, page, appel MCP).
//
// Quand 1 et 2 sont réunis, chaque appel sortant demande ton accord, avec ce
// qui va sortir exactement.
//
// Un résultat de connecteur (MCP) est les deux à la fois : écrit par n'importe qui
// (un ticket ouvert par un client) ET privé (lu avec le compte de l'utilisateur).
// Il peut repartir vers CE connecteur sans accord (la donnée ne change pas de
// mains) ; vers le web ou un autre connecteur, l'accord est demandé. La règle se fonde sur la PROVENANCE des contenus,
// jamais sur leur texte : une injection reformulée n'y change rien, contrairement
// à la détection (security/injection.ts), qui reste un complément.

export type Exposure = {
  untrusted: boolean;
  sensitive: boolean;
  /** Outils de connecteur dont un résultat a été lu (données privées d'un service tiers). */
  connectors?: string[] | undefined;
};

const isMcp = (name: string) => name.startsWith("mcp_");

/** Résultats écrits par des inconnus. */
// Script de compétence : du code écrit par un tiers (souvent téléchargé), sa sortie n'est pas fiable.
const UNTRUSTED_RESULT = (name: string) => name === "web_search" || name === "read_webpage" || isMcp(name) || name === "delegate_task" || name === "run_skill_script";
/** Résultats tirés des données de l'organisation. */
// Compétences : documents internes de l'organisation, comme la base de connaissances.
const SENSITIVE_RESULT = (name: string) => name === "search_knowledge" || name === "delegate_task" || name === "use_skill" || name === "read_skill_file";
const readsUserFiles = (turn: { name: string; data?: unknown }) =>
  turn.name === "run_code" && typeof turn.data === "object" && turn.data !== null && Number((turn.data as { inputs?: unknown }).inputs) > 0;
/** Appels dont les arguments quittent la plateforme. */
export const isOutbound = (name: string) => name === "web_search" || name === "read_webpage" || isMcp(name);

/**
 * Exposition d'une réponse, d'après sa transcription jusqu'ici (les tours déjà
 * écrits : identique quand une réponse reprend après une pause).
 */
export function exposureOf(turns: ChatTurn[]): Exposure {
  const exposure: Exposure = { untrusted: false, sensitive: false };
  const connectors = new Set<string>();
  for (const turn of turns) {
    if (turn.role === "user") {
      // Pièce jointe : un fichier venu d'ailleurs, et une donnée de l'utilisateur.
      if (turn.content.includes("<document name=")) {
        exposure.untrusted = true;
        exposure.sensitive = true;
      }
      // Passages de la base injectés dans le message (mode connaissance sans outils).
      if (turn.content.includes("<knowledge>")) exposure.sensitive = true;
    }
    if (turn.role === "tool" && !turn.isError) {
      // Code du modèle qui a lu des pièces jointes : sa sortie vaut une pièce jointe.
      if (readsUserFiles(turn)) {
        exposure.untrusted = true;
        exposure.sensitive = true;
      }
      if (UNTRUSTED_RESULT(turn.name)) exposure.untrusted = true;
      if (SENSITIVE_RESULT(turn.name)) exposure.sensitive = true;
      if (isMcp(turn.name)) connectors.add(turn.name);
    }
  }
  return connectors.size ? { ...exposure, connectors: [...connectors] } : exposure;
}

/** Union de deux expositions (réponse en cours + celle héritée par un sous-agent). */
export function mergeExposure(own: Exposure, inherited: Exposure | undefined): Exposure {
  const connectors = [...new Set([...(own.connectors ?? []), ...(inherited?.connectors ?? [])])];
  return {
    untrusted: own.untrusted || Boolean(inherited?.untrusted),
    sensitive: own.sensitive || Boolean(inherited?.sensitive),
    ...(connectors.length ? { connectors } : {}),
  };
}

export const isExposed = (exposure: Exposure | undefined) => Boolean(exposure?.untrusted && (exposure.sensitive || exposure.connectors?.length));

/** Ce que l'utilisateur voit avant d'autoriser un appel sortant. */
function outboundPreview(tool: AgentTool, args: unknown): ToolPreview {
  const value = (args ?? {}) as Record<string, unknown>;
  const base = tool.preview?.(args) ?? (
    tool.name === "web_search"
      ? { title: "Envoyer une recherche sur le web", detail: String(value.query ?? "") }
      : tool.name === "read_webpage"
        ? { title: "Ouvrir une page web", detail: String(value.url ?? "") }
        : { title: `Appeler ${tool.name}`, detail: JSON.stringify(value, null, 2).slice(0, 2_000) }
  );
  return { ...base, exposure: true };
}

/**
 * Outils d'une étape exposée : les appels sortants deviennent des actions à
 * valider (comme une écriture). Rien ne change pour une réponse non exposée.
 */
export function gateOutbound(tools: AgentTool[], exposure: Exposure | undefined): AgentTool[] {
  if (!exposure || !isExposed(exposure)) return tools;
  // Connecteurs d'où viennent les données lues ; un nom inconnu compte comme une source à part.
  const origins = new Map(tools.flatMap((tool) => (tool.origin ? [[tool.name, tool.origin] as const] : [])));
  const sources = new Set((exposure.connectors ?? []).map((name) => origins.get(name) ?? `?${name}`));
  // Retour vers le seul connecteur déjà lu, sans autre donnée interne : rien ne change de mains.
  const sameConnector = (tool: AgentTool) => !exposure.sensitive && tool.origin !== undefined && sources.size === 1 && sources.has(tool.origin);
  return tools.map((tool) => (isOutbound(tool.name) && !sameConnector(tool) ? { ...tool, access: "write", preview: (args) => outboundPreview(tool, args) } : tool));
}
