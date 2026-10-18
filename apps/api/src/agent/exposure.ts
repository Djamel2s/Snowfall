import type { ChatTurn } from "../graph/chat-graph.js";
import type { AgentTool, ToolPreview } from "./tools.js";

// « Règle de deux » : un agent ne doit pas, sans accord humain, cumuler les
// trois capacités suivantes dans une même réponse :
//   1. avoir lu un contenu non fiable (page web, résultat MCP, pièce jointe) ;
//   2. avoir lu des données internes (base de connaissances, pièce jointe) ;
//   3. envoyer quelque chose vers l'extérieur (recherche web, page, appel MCP).
//
// Quand 1 et 2 sont réunis, chaque appel sortant demande ton accord, avec ce
// qui va sortir exactement. La règle se fonde sur la PROVENANCE des contenus,
// jamais sur leur texte : une injection reformulée n'y change rien, contrairement
// à la détection (security/injection.ts), qui reste un complément.

export type Exposure = { untrusted: boolean; sensitive: boolean };

const isMcp = (name: string) => name.startsWith("mcp_");

/** Résultats écrits par des inconnus. */
const UNTRUSTED_RESULT = (name: string) => name === "web_search" || name === "read_webpage" || isMcp(name);
/** Résultats tirés des données de l'organisation. */
const SENSITIVE_RESULT = (name: string) => name === "search_knowledge" || name === "ask_agent";
/** Appels dont les arguments quittent la plateforme. */
export const isOutbound = (name: string) => name === "web_search" || name === "read_webpage" || isMcp(name);

/**
 * Exposition d'une réponse, d'après sa transcription jusqu'ici (les tours déjà
 * écrits : identique quand une réponse reprend après une pause).
 */
export function exposureOf(turns: ChatTurn[]): Exposure {
  const exposure: Exposure = { untrusted: false, sensitive: false };
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
      if (UNTRUSTED_RESULT(turn.name)) exposure.untrusted = true;
      if (SENSITIVE_RESULT(turn.name)) exposure.sensitive = true;
    }
  }
  return exposure;
}

export const isExposed = (exposure: Exposure | undefined) => Boolean(exposure?.untrusted && exposure.sensitive);

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
  if (!isExposed(exposure)) return tools;
  return tools.map((tool) => (isOutbound(tool.name) ? { ...tool, access: "write", preview: (args) => outboundPreview(tool, args) } : tool));
}
