import { detectInjection, flagIfSuspicious, INJECTION_NOTICE, type InjectionVerdict } from "../security/injection.js";
import type { AgentTool } from "./tools.js";

/** Contenu suspect déjà vu pendant cette réponse (pièce jointe, résultat d'outil, tour précédent). */
export type TaintState = { tainted: boolean };

/**
 * Garde contre les injections, autour des outils d'une réponse :
 * - lecture : un résultat suspect reçoit l'avertissement de la plateforme, et
 *   l'événement est signalé (audit, sans contenu) ;
 * - écriture : après un contenu suspect, la demande de validation porte une
 *   alerte, pour que l'humain qui décide sache d'où peut venir la demande.
 *
 * Ne bloque rien : une fausse alerte ne doit pas casser une réponse, et la
 * validation humaine reste la barrière des écritures.
 */
export function guardTools(tools: AgentTool[], state: TaintState, onSuspect: (tool: string, verdict: InjectionVerdict) => void): AgentTool[] {
  return tools.map((tool): AgentTool => {
    if (tool.access === "write") {
      const preview = tool.preview!;
      return { ...tool, preview: (args) => ({ ...preview(args), ...(state.tainted ? { warning: true } : {}) }) };
    }
    return {
      ...tool,
      async execute(args, context) {
        const result = await tool.execute(args, context);
        // Déjà averti plus bas (passage de la base) : pas de second avertissement, mais signalé.
        if (result.content.includes(INJECTION_NOTICE)) {
          state.tainted = true;
          onSuspect(tool.name, detectInjection(result.content.split(INJECTION_NOTICE).join("")));
          return result;
        }
        const { text, verdict } = flagIfSuspicious(result.content);
        if (!verdict.suspicious) return result;
        state.tainted = true;
        onSuspect(tool.name, verdict);
        return { ...result, content: text };
      },
    };
  });
}

/** Un contenu déjà transmis au modèle portait l'avertissement (pièce jointe, étape d'avant une pause). */
export const carriesNotice = (texts: string[]) => texts.some((text) => text.includes(INJECTION_NOTICE));
