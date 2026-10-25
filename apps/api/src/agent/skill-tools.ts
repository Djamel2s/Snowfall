import { z } from "zod";
import type { TenantContext } from "../db/tenant.js";
import type { SkillCatalogEntry, SkillStore } from "../skills/store.js";
import { defineTool, type AgentTool } from "./tools.js";

// Compétences : chargement progressif. Le catalogue (nom + description) tient
// dans la description de l'outil ; les instructions et les fichiers ne sont lus
// que si le modèle en a besoin. Lecture seule : aucune validation demandée.

/** Au-delà, le fichier est tronqué : le contexte du modèle reste borné. */
export const SKILL_FILE_CHARS = 20_000;

/** Une ligne du catalogue : jamais de saut de ligne venu d'une description (rien ne s'y glisse). */
const line = (skill: SkillCatalogEntry) => `- ${skill.id} — ${skill.name.replace(/\s+/g, " ")} : ${skill.description.replace(/\s+/g, " ")}`;

export function skillTools(deps: { store: SkillStore; tenant: TenantContext; agentId: string; catalog: SkillCatalogEntry[] }): AgentTool[] {
  if (deps.catalog.length === 0) return [];
  const known = new Set(deps.catalog.map((skill) => skill.id));
  const skillId = z.string().refine((id) => known.has(id), "compétence inconnue : choisis un identifiant du catalogue");

  const useSkill = defineTool({
    name: "use_skill",
    description:
      "Charge les instructions détaillées d'une compétence (savoir-faire de l'organisation) avant de faire la tâche qu'elle décrit. " +
      "Charge-la quand la demande correspond à sa description ; suis ensuite ses instructions. " +
      "En parlant à l'utilisateur, nomme les compétences, sans leur identifiant. Compétences disponibles :\n" +
      deps.catalog.map(line).join("\n"),
    parameters: z.object({ skill: skillId.describe("Identifiant de la compétence (catalogue ci-dessus).") }).strict(),
    access: "read",
    async execute({ skill }) {
      const loaded = await deps.store.load(deps.tenant, deps.agentId, skill);
      if (!loaded) return { content: "Compétence indisponible.", summary: "Indisponible", isError: true };
      const files = loaded.files.length
        ? `\n\nFichiers de référence (read_skill_file) :\n${loaded.files.map((file) => `- ${file.id} — ${file.name}`).join("\n")}`
        : "";
      return { content: `Compétence « ${loaded.name} » :\n\n${loaded.instructions}${files}`, summary: loaded.name };
    },
  });

  const readFile = defineTool({
    name: "read_skill_file",
    description: "Lit un fichier de référence d'une compétence déjà chargée avec use_skill (modèle, charte, exemple…).",
    parameters: z
      .object({
        skill: skillId.describe("Identifiant de la compétence."),
        file: z.string().min(1).max(64).describe("Identifiant du fichier, donné par use_skill."),
      })
      .strict(),
    access: "read",
    async execute({ skill, file }) {
      const found = await deps.store.readFile(deps.tenant, deps.agentId, skill, file);
      if (!found) return { content: "Fichier introuvable dans cette compétence.", summary: "Introuvable", isError: true };
      const text = found.text.length > SKILL_FILE_CHARS ? `${found.text.slice(0, SKILL_FILE_CHARS)}\n[… fichier tronqué]` : found.text;
      return { content: `Fichier « ${found.name} » :\n\n${text}`, summary: found.name };
    },
  });

  return [useSkill, readFile];
}
