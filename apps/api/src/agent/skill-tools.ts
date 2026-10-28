import { z } from "zod";
import type { TenantContext } from "../db/tenant.js";
import { copiedToSandbox, sandboxPath, SKILL_SCRIPT_TYPE } from "../skills/scripts.js";
import type { SkillCatalogEntry, SkillStore } from "../skills/store.js";
import { copyInputs, deliverRun, MAX_RUNS, MAX_SCRIPT_INPUTS, RUNS_EXHAUSTED, SANDBOX_INPUT_BYTES, type SandboxDeps, type ScriptInputs, type SkillRunFile } from "./code-tool.js";
import { defineTool, type AgentTool } from "./tools.js";

// Compétences : chargement progressif. Le catalogue (nom + description) tient
// dans la description de l'outil ; les instructions et les fichiers ne sont lus
// que si le modèle en a besoin. Lecture seule : aucune validation demandée.
// Scripts (Python) : exécutés dans le bac à sable, comme le code du modèle, et
// seulement si l'agent a « Exécuter du code ».

/** Au-delà, le fichier est tronqué : le contexte du modèle reste borné. */
export const SKILL_FILE_CHARS = 20_000;
export { MAX_SCRIPT_INPUTS, type ScriptInputs };

/**
 * Fichier désigné par le modèle : son identifiant, ou son nom (avec ou sans dossier),
 * ou — s'il n'y a qu'un candidat — rien. Les modèles mélangent les trois.
 */
function pickFile<T extends { id: string; name: string }>(files: T[], wanted: string | undefined): T | undefined {
  if (!wanted) return files.length === 1 ? files[0] : undefined;
  const key = wanted.trim().toLowerCase();
  const base = (name: string) => name.toLowerCase().split("/").pop()!;
  return files.find((file) => file.id === wanted) ?? files.find((file) => file.name.toLowerCase() === key) ?? files.find((file) => base(file.name) === base(key));
}

const listing = (files: { id: string; name: string }[]) => files.map((file) => `- ${file.id} — ${file.name}`).join("\n");

/** Une ligne du catalogue : jamais de saut de ligne venu d'une description (rien ne s'y glisse). */
const line = (skill: SkillCatalogEntry) => `- ${skill.id} — ${skill.name.replace(/\s+/g, " ")} : ${skill.description.replace(/\s+/g, " ")}`;

export function skillTools(deps: {
  store: SkillStore;
  tenant: TenantContext;
  agentId: string;
  catalog: SkillCatalogEntry[];
  /** Bac à sable : présent seulement si l'agent peut exécuter du code. */
  scripts?: (SandboxDeps & { inputs?: ScriptInputs | undefined }) | undefined;
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
      // Avec les scripts : chemin de chaque fichier dans le bac à sable (à passer en argument).
      const where = (file: { name: string; hasOriginal: boolean; mediaType: string }) => {
        const path = sandboxPath(file.name);
        return deps.scripts && path && (file.hasOriginal || copiedToSandbox(file.mediaType)) ? ` (scripts : skill/${path})` : "";
      };
      if (references.length) parts.push(`Fichiers de référence (read_skill_file) :\n${references.map((file) => `- ${file.id} — ${file.name}${where(file)}`).join("\n")}`);
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
        file: z.string().min(1).max(200).describe("Identifiant (ou nom) du fichier, donné par use_skill."),
      })
      .strict(),
    access: "read",
    async execute({ skill, file }) {
      const loaded = await deps.store.load(deps.tenant, deps.agentId, skill);
      const chosen = loaded ? pickFile(loaded.files, file) : undefined;
      const found = chosen ? await deps.store.readFile(deps.tenant, deps.agentId, skill, chosen.id) : null;
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
      "Le script est dans skill/ avec les fichiers de la compétence (modèles compris) ; les pièces jointes demandées dans « files » " +
      "sont copiées dans inputs/ (passe leur chemin en argument, ex. inputs/loyers.xlsx). Les fichiers qu'il crée dans le dossier " +
      "courant sont donnés à l'utilisateur. Chaque exécution repart de zéro. Délai : 30 s.",
    parameters: z
      .object({
        skill: skillId.describe("Identifiant de la compétence."),
        script: z.string().min(1).max(200).optional().describe("Identifiant (ou nom de fichier) du script, donné par use_skill ; facultatif si la compétence n'a qu'un script."),
        arguments: z.array(z.string().max(2_000)).max(20).default([]).describe("Arguments du script (sys.argv[1:])."),
        files: z
          .array(z.string().min(1).max(120))
          .max(MAX_SCRIPT_INPUTS)
          .default([])
          .describe("Noms exacts de pièces jointes de la conversation à copier dans inputs/."),
      })
      .strict(),
    access: "read",
    async execute({ skill, script, arguments: args, files: wanted }, { signal }) {
      if (sandbox.runs.count >= MAX_RUNS) return { content: RUNS_EXHAUSTED, summary: "limite" };
      const loaded = await deps.store.load(deps.tenant, deps.agentId, skill);
      const scripts = loaded?.files.filter((file) => file.mediaType === SKILL_SCRIPT_TYPE) ?? [];
      const entry = pickFile(scripts, script);
      // Erreur utile : les scripts disponibles, pour que le modèle corrige son appel (et ne calcule pas de tête).
      if (!loaded || !entry) {
        return {
          content: scripts.length
            ? `Script introuvable : « ${script ?? ""} ». Scripts de cette compétence (réessaie avec l'un d'eux) :\n${listing(scripts)}`
            : "Cette compétence n'a pas de script.",
          summary: "Introuvable",
          isError: true,
        };
      }

      // Fichiers de la compétence sous skill/, chemins sûrs : le script d'abord, puis les
      // autres tant que le total tient dans la limite du bac à sable (un chemin en
      // double : le premier gardé). Texte tel quel ; modèle binaire : son original.
      const files: SkillRunFile[] = [];
      let entryPath: string | null = null;
      let total = 0;
      const free = (path: string) => !files.some((other) => other.path === path || other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`));
      const ordered = [entry, ...loaded.files.filter((item) => item.id !== entry.id && (item.hasOriginal || copiedToSandbox(item.mediaType)))];
      for (const file of ordered) {
        const relative = sandboxPath(file.name);
        const path = relative && `skill/${relative}`;
        if (!path || !free(path)) continue;
        if (file.hasOriginal) {
          const bytes = await deps.store.readOriginal(deps.tenant, deps.agentId, skill, file.id);
          const data = bytes?.toString("base64");
          if (!data || total + data.length > SANDBOX_INPUT_BYTES) continue;
          total += data.length;
          files.push({ path, data });
          continue;
        }
        const read = await deps.store.readFile(deps.tenant, deps.agentId, skill, file.id);
        if (!read) continue;
        const size = Buffer.byteLength(read.text, "utf8");
        if (total + size > SANDBOX_INPUT_BYTES) continue;
        total += size;
        files.push({ path, content: read.text });
        if (file.id === entry.id) entryPath = path;
      }
      if (!entryPath) return { content: "Script inutilisable : son nom n'est pas un chemin accepté par le bac à sable.", summary: "Refusé", isError: true };

      // Pièces jointes demandées, cherchées dans CETTE conversation seulement, sous inputs/.
      const { note } = await copyInputs(wanted, sandbox.inputs, files, total);

      sandbox.runs.count++;
      const result = await sandbox.sandbox.run("", { timeoutSeconds: 30, signal, skill: { files, entry: entryPath, args } });
      const delivered = await deliverRun(result, sandbox);
      return note ? { ...delivered, content: `${note}\n\n${delivered.content}` } : delivered;
    },
  });

  return [useSkill, readFile, runScript];
}
