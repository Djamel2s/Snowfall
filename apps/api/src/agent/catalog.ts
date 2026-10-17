// Catalogue des outils de la plateforme et règle d'autorisation.
//
//   plateforme (ce catalogue)  ⊇  organisation (réglage admin)  ⊇  agent (choix de l'auteur)
//
// puis, à l'exécution, l'utilisateur approuve chaque appel d'écriture.
// Un outil absent d'un niveau n'est même pas proposé au modèle.

export const toolIds = ["search_knowledge", "save_to_knowledge", "web_search", "code_interpreter", "mcp"] as const;
export type ToolId = (typeof toolIds)[number];

export const toolAccess: Record<ToolId, "read" | "write"> = {
  search_knowledge: "read",
  save_to_knowledge: "write",
  // Lecture seule, mais la requête sort de la plateforme (moteurs publics) :
  // jamais proposée à une conversation confidentielle.
  web_search: "read",
  // Lecture : le code tourne dans un bac à sable sans réseau, sans effet hors de lui.
  // Local : permis aussi aux conversations confidentielles.
  code_interpreter: "read",
  // Serveurs d'outils externes approuvés par l'admin. Écriture par prudence :
  // l'accès réel est fixé outil par outil à l'approbation. Jamais en confidentiel.
  mcp: "write",
};

/** Outils qui demandent un service de la plateforme (SearXNG, bac à sable, MCP activé). */
export const platformDependentTools: ToolId[] = ["web_search", "code_interpreter", "mcp"];

/**
 * Outils de l'organisation par défaut : ceux de la base de connaissances (les
 * écritures restent soumises à validation). La recherche web est à activer :
 * des requêtes sortent alors vers les moteurs publics.
 */
export const defaultOrganizationTools: ToolId[] = ["search_knowledge", "save_to_knowledge"];

/** Agent créé avant le choix des outils, ou sans choix : lecture seule. */
export const defaultAgentTools: ToolId[] = ["search_knowledge"];

/** Garde les identifiants connus, sans doublon, dans l'ordre du catalogue. */
export function knownTools(values: readonly string[]): ToolId[] {
  return toolIds.filter((id) => values.includes(id));
}

/**
 * Outils permis pour une réponse. Sans agent, ceux d'un agent par défaut
 * (lecture de la base) : une écriture a besoin d'une cible dont l'auteur a
 * autorisé la modification, et la recherche web d'un choix explicite.
 */
export function permittedTools(organization: readonly ToolId[], agent: readonly ToolId[] | null): Set<ToolId> {
  const chosen = agent ?? defaultAgentTools;
  return new Set(toolIds.filter((id) => organization.includes(id) && chosen.includes(id)));
}
