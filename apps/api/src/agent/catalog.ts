// Catalogue des outils de la plateforme et règle d'autorisation.
//
//   plateforme (ce catalogue)  ⊇  organisation (réglage admin)  ⊇  agent (choix de l'auteur)
//
// puis, à l'exécution, l'utilisateur approuve chaque appel d'écriture.
// Un outil absent d'un niveau n'est même pas proposé au modèle.

export const toolIds = ["search_knowledge", "save_to_knowledge"] as const;
export type ToolId = (typeof toolIds)[number];

export const toolAccess: Record<ToolId, "read" | "write"> = {
  search_knowledge: "read",
  save_to_knowledge: "write",
};

/** Outils de l'organisation par défaut : tous (les écritures restent soumises à validation). */
export const defaultOrganizationTools: ToolId[] = [...toolIds];

/** Agent créé avant le choix des outils, ou sans choix : lecture seule. */
export const defaultAgentTools: ToolId[] = ["search_knowledge"];

/** Garde les identifiants connus, sans doublon, dans l'ordre du catalogue. */
export function knownTools(values: readonly string[]): ToolId[] {
  return toolIds.filter((id) => values.includes(id));
}

/**
 * Outils permis pour une réponse. Sans agent, seulement la lecture : une
 * écriture a besoin d'une cible dont l'auteur a autorisé la modification.
 */
export function permittedTools(organization: readonly ToolId[], agent: readonly ToolId[] | null): Set<ToolId> {
  const chosen = agent ?? toolIds.filter((id) => toolAccess[id] === "read");
  return new Set(toolIds.filter((id) => organization.includes(id) && chosen.includes(id)));
}
