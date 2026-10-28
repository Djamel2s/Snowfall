import type { EvalCase, EvalToolId } from "../evals/agent-eval.js";
import { loadCatalog } from "./load.js";
import type { AgentTemplate } from "./types.js";

// Catalogue des agents prêts à l'emploi (apps/api/catalog/, un dossier par agent).
// Chaque modèle arrive avec son jeu d'évaluation : la qualité affichée est mesurée, pas déclarée.

export const AGENT_TEMPLATES: AgentTemplate[] = loadCatalog();

export const templateById = (id: string) => AGENT_TEMPLATES.find((template) => template.id === id);

/** Outils que le banc sait simuler (les autres sont retirés des cas). */
// L'interpréteur de code n'est jamais simulé : il n'est branché qu'avec le vrai bac à sable (--sandbox).
const SIMULATED: EvalToolId[] = ["search_knowledge", "save_to_knowledge", "web_search", "save_memory", "code_interpreter"];

/**
 * Cas d'évaluation d'un modèle : l'agent tel qu'il sera installé (instructions,
 * compétences, outils), sur ses seuls documents (pas le corpus du banc).
 */
export function templateEvalCases(template: AgentTemplate): EvalCase[] {
  const tools = template.tools.flatMap((tool) => ((SIMULATED as string[]).includes(tool) ? [tool as EvalToolId] : []));
  return template.evaluation.cases.map(({ tools: own, ...item }): EvalCase => ({
    ...item,
    id: `${template.id}/${item.id}`,
    instructions: template.instructions,
    tools: own ?? tools,
    corpus: "case",
    skills: evalSkills(template),
    // Équipe : les spécialistes du catalogue, tels qu'ils seront installés.
    ...(template.team?.length
      ? { team: template.team.flatMap((id) => { const member = templateById(id); return member ? [{ id: member.id, name: member.name, instructions: member.instructions, skills: evalSkills(member) }] : []; }) }
      : {}),
  }));
}

function evalSkills(template: AgentTemplate) {
  return template.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    ...(skill.files?.some((file) => file.name.endsWith(".py")) ? { scripts: skill.files.filter((file) => file.name.endsWith(".py")) } : {}),
  }));
}
