import { z } from "zod";

// Un outil = un nom, une description (que le modèle lit pour décider de
// l'utiliser), un schéma d'arguments, et une fonction exécutée par NOTRE code.
// Le modèle ne fait que demander l'appel : il ne touche jamais au système.

export type ToolResult = {
  /** Texte renvoyé au modèle (donnée non fiable, balisée par la boucle). */
  content: string;
  /** Résumé d'une ligne affiché à l'utilisateur pendant l'exécution. */
  summary?: string;
};

export interface AgentTool<Args extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: Args;
  /** « read » : lecture seule ; « write » : modifie ou envoie (validation humaine, étape suivante). */
  access: "read" | "write";
  execute(args: z.infer<Args>, context: { signal: AbortSignal }): Promise<ToolResult>;
}

/** Ce que le fournisseur reçoit : nom, description, schéma JSON des arguments. */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export function toolSpec(tool: AgentTool): ToolSpec {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, parameters };
}

export const TOOL_TIMEOUT_MS = 30_000;
/** Résultat d'outil renvoyé au modèle (au-delà, tronqué) : protège le contexte. */
export const TOOL_RESULT_CHARS = 24_000;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function defineTool<Args extends z.ZodType>(tool: AgentTool<Args>): AgentTool<Args> {
  if (!NAME.test(tool.name)) throw new Error(`Nom d'outil invalide : ${tool.name}`);
  return tool;
}

/**
 * Exécute un appel demandé par le modèle, sans jamais lever d'exception :
 * outil inconnu, arguments invalides, délai dépassé ou erreur deviennent un
 * résultat d'erreur que le modèle lit et peut corriger au tour suivant.
 */
export async function runTool(
  tools: AgentTool[],
  call: { name: string; arguments: unknown },
  signal: AbortSignal,
): Promise<ToolResult & { isError: boolean }> {
  const tool = tools.find((item) => item.name === call.name);
  if (!tool) return { content: `Outil inconnu : ${call.name}.`, isError: true };

  // Le modèle peut produire des arguments faux : toujours valider.
  const parsed = tool.parameters.safeParse(call.arguments);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`).join(" ; ");
    return { content: `Arguments invalides pour ${tool.name} — ${issues.slice(0, 500)}`, isError: true };
  }

  const timeout = AbortSignal.timeout(TOOL_TIMEOUT_MS);
  try {
    const result = await tool.execute(parsed.data, { signal: AbortSignal.any([signal, timeout]) });
    const content = result.content.length > TOOL_RESULT_CHARS ? `${result.content.slice(0, TOOL_RESULT_CHARS)}\n[… résultat tronqué]` : result.content;
    return { ...result, content, isError: false };
  } catch (error) {
    if (signal.aborted) throw error;
    // Détails internes jamais renvoyés au modèle (ni à l'utilisateur).
    return { content: timeout.aborted ? `${tool.name} : délai dépassé.` : `${tool.name} : échec de l'exécution.`, isError: true };
  }
}
