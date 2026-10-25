import { z } from "zod";
import type { TenantContext } from "../db/tenant.js";
import { copiedToSandbox, sandboxPath, SKILL_SCRIPT_TYPE } from "../skills/scripts.js";
import type { SkillCatalogEntry, SkillStore } from "../skills/store.js";
import { deliverRun, MAX_RUNS, RUNS_EXHAUSTED, type SandboxDeps } from "./code-tool.js";
import { defineTool, type AgentTool } from "./tools.js";

// Compétences : chargement progressif. Le catalogue (nom + description) tient
// dans la description de l'outil ; les instructions et les fichiers ne sont lus
// que si le modèle en a besoin. Lecture seule : aucune validation demandée.
// Scripts (Python) : exécutés dans le bac à sable, comme le code du modèle, et
// seulement si l'agent a « Exécuter du code ».

/** Au-delà, le fichier est tronqué : le contexte du modèle reste borné. */
export const SKILL_FILE_CHARS = 20_000;
/** Fichiers copiés à côté d'un script : sous la limite du bac à sable (2 Mio). */
const SANDBOX_INPUT_BYTES = 1_900_000;

/** Une ligne du catalogue : jamais de saut de ligne venu d'une description (rien ne s'y glisse). */
const line = (skill: SkillCatalogEntry) => `- ${skill.id} — ${skill.name.replace(/\s+/g, " ")} : ${skill.description.replace(/\s+/g, " ")}`;

export function skillTools(deps: {
  store: SkillStore;
  tenant: TenantContext;
  agentId: string;
  catalog: SkillCatalogEntry[];
  /** Bac à sable : présent seulement si l'agent peut exécuter du code. */
  scripts?: SandboxDeps | undefined;
}): AgentTool[] {
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
      const references = loaded.files.filter((file) => file.mediaType !== SKILL_SCRIPT_TYPE);
      const scripts = loaded.files.filter((file) => file.mediaType === SKILL_SCRIPT_TYPE);
      const parts = [`Compétence « ${loaded.name} » :\n\n${loaded.instructions}`];
      if (references.length) parts.push(`Fichiers de référence (read_skill_file) :\n${references.map((file) => `- ${file.id} — ${file.name}`).join("\n")}`);
      if (scripts.length) {
        parts.push(
          deps.scripts
            ? `Scripts (run_skill_script ; lisibles avec read_skill_file) :\n${scripts.map((file) => `- ${file.id} — ${file.name}`).join("\n")}`
            : `Scripts présents (${scripts.map((file) => file.name).join(", ")}) mais non exécutables ici : l'agent n'a pas « Exécuter du code ». Fais sans, ou dis-le si c'est indispensable.`,
        );
      }
      return { content: parts.join("\n\n"), summary: loaded.name };
    },
  });

  const readFile = defineTool({
    name: "read_skill_file",
    description: "Lit un fichier de référence (ou un script) d'une compétence déjà chargée avec use_skill (modèle, charte, exemple…).",
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

  if (!deps.scripts) return [useSkill, readFile];
  const sandbox = deps.scripts;

  const runScript = defineTool({
    name: "run_skill_script",
    description:
      "Exécute un script Python d'une compétence (chargée avec use_skill) dans le bac à sable isolé, SANS réseau. " +
      "Les fichiers texte de la compétence sont à côté du script ; les fichiers qu'il crée dans le dossier courant sont donnés à l'utilisateur. " +
      "Passe les données en arguments (liste de textes). Chaque exécution repart de zéro. Délai : 30 s.",
    parameters: z
      .object({
        skill: skillId.describe("Identifiant de la compétence."),
        script: z.string().min(1).max(64).describe("Identifiant du script, donné par use_skill."),
        arguments: z.array(z.string().max(2_000)).max(20).default([]).describe("Arguments du script (sys.argv[1:])."),
      })
      .strict(),
    access: "read",
    async execute({ skill, script, arguments: args }, { signal }) {
      if (sandbox.runs.count >= MAX_RUNS) return { content: RUNS_EXHAUSTED, summary: "limite" };
      const loaded = await deps.store.load(deps.tenant, deps.agentId, skill);
      const entry = loaded?.files.find((file) => file.id === script && file.mediaType === SKILL_SCRIPT_TYPE);
      if (!loaded || !entry) return { content: "Script introuvable dans cette compétence (voir use_skill).", summary: "Introuvable", isError: true };

      // Fichiers texte de la compétence, sous des chemins sûrs : le script d'abord, puis
      // les autres tant que le total tient dans la limite du bac à sable (un chemin en
      // double : le premier gardé).
      const files: { path: string; content: string }[] = [];
      let entryPath: string | null = null;
      let total = 0;
      const ordered = [entry, ...loaded.files.filter((item) => item.id !== entry.id && copiedToSandbox(item.mediaType))];
      for (const file of ordered) {
        const path = sandboxPath(file.name);
        if (!path || files.some((other) => other.path === path || other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`))) continue;
        const read = await deps.store.readFile(deps.tenant, deps.agentId, skill, file.id);
        if (!read) continue;
        const size = Buffer.byteLength(read.text, "utf8");
        if (total + size > SANDBOX_INPUT_BYTES) continue;
        total += size;
        files.push({ path, content: read.text });
        if (file.id === entry.id) entryPath = path;
      }
      if (!entryPath) return { content: "Script inutilisable : son nom n'est pas un chemin accepté par le bac à sable.", summary: "Refusé", isError: true };

      sandbox.runs.count++;
      const result = await sandbox.sandbox.run("", { timeoutSeconds: 30, signal, skill: { files, entry: entryPath, args } });
      return deliverRun(result, sandbox);
    },
  });

  return [useSkill, readFile, runScript];
}
