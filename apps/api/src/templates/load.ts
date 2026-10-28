import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { toolIds } from "../agent/catalog.js";
import { agentProfileSchema } from "../agents/profile.js";
import type { AgentTemplate, TemplateEvalCase, TemplateSkill } from "./types.js";

// Le catalogue est une DONNÉE, rangée dans apps/api/catalog/ (un dossier par agent) :
//
//   catalog.json                     ordre d'affichage
//   agents/<id>/agent.json           fiche : nom, outils, connecteurs, limites…
//   agents/<id>/instructions.md      prompt système
//   agents/<id>/skills/<nom>/SKILL.md  compétence (en-tête name / description) + ses fichiers
//   agents/<id>/evals/cases.json     jeu d'évaluation ; pièces jointes à côté
//
// Lu et validé au démarrage : un fichier invalide empêche l'API de démarrer (jamais
// un agent à moitié chargé). Il ne passe pas par la base : chaque organisation
// installe ce qu'elle veut, par les routes ordinaires.

export const CATALOG_DIR = fileURLToPath(new URL("../../catalog/", import.meta.url));

const text = z.string().trim().min(1);
const evalDocument = z.object({ name: text, file: text }).strict();

const check = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_called"), tool: text, min: z.number().int().optional(), max: z.number().int().optional() }).strict(),
  z.object({ type: z.literal("tool_not_called"), tool: text }).strict(),
  z.object({ type: z.literal("argument_includes"), tool: text, text }).strict(),
  z.object({ type: z.literal("argument_excludes"), text, tool: text.optional() }).strict(),
  z.object({ type: z.literal("answer_includes"), groups: z.array(z.array(text).min(1)).min(1) }).strict(),
  z.object({ type: z.literal("answer_excludes"), texts: z.array(text).min(1) }).strict(),
  z.object({ type: z.literal("cites") }).strict(),
  z.object({ type: z.literal("max_steps"), steps: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("file_produced"), extension: text }).strict(),
]);

const evalCase = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    category: z.enum(["rag", "outils", "sécurité", "web"]),
    description: text,
    /** Pourquoi un contrôle est écrit ainsi (pour qui modifie le cas). */
    note: text.optional(),
    question: text,
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: text }).strict()).optional(),
    tools: z.array(z.enum(["search_knowledge", "save_to_knowledge", "web_search", "save_memory", "code_interpreter"])).optional(),
    documents: z.array(evalDocument).optional(),
    attachments: z.array(evalDocument).optional(),
    memories: z.array(text).optional(),
    web: z
      .object({
        results: z.array(z.object({ title: z.string(), url: z.url(), snippet: z.string() }).strict()),
        pages: z.record(z.string(), z.object({ title: z.string(), text: z.string() }).strict()).optional(),
      })
      .strict()
      .optional(),
    scriptOutput: z.string().optional(),
    sandbox: z.boolean().optional(),
    approve: z.boolean().optional(),
    checks: z.array(check).min(1),
    rubric: text.optional(),
  })
  .strict();

const agentFile = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    category: z.enum(["rh", "juridique", "conformite", "achats", "donnees", "support", "projet", "redaction", "commercial", "general"]),
    name: text,
    tagline: text,
    capabilities: z.array(text).min(1),
    limits: z.array(text).min(1),
    avatar: agentProfileSchema.shape.avatar,
    tools: z.array(z.enum(toolIds)),
    parameters: agentProfileSchema.shape.parameters,
    connectors: z.array(text),
    knowledge: z.array(text),
    starters: z.array(text).min(1),
    team: z.array(text).optional(),
    /** Dossiers de skills/, dans l'ordre. */
    skills: z.array(z.string().regex(/^[a-z0-9-]+$/)),
    measured: z.object({ model: text, passed: z.number().int(), total: z.number().int(), date: text }).strict().optional(),
  })
  .strict();

// Fins de ligne unifiées : le même contenu, quel que soit le poste (Windows, Linux).
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const json = <T>(schema: z.ZodType<T>, path: string) => {
  const parsed = schema.safeParse(JSON.parse(read(path)));
  if (!parsed.success) throw new Error(`Catalogue invalide : ${path}\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
};
/** Nom de fichier simple, dans le dossier (aucun « .. » ni sous-dossier). */
const inside = (folder: string, name: string) => {
  if (!/^[^/\\]+$/.test(name) || name.startsWith(".")) throw new Error(`Catalogue invalide : nom de fichier « ${name} » dans ${folder}`);
  return join(folder, name);
};

/** SKILL.md : en-tête « name » / « description » (une ligne chacun), puis les instructions. */
function skill(folder: string): TemplateSkill {
  const source = read(join(folder, "SKILL.md"));
  const match = /^---\nname: (.+)\ndescription: (.+)\n---\n\n([\s\S]+)$/.exec(source);
  if (!match) throw new Error(`Catalogue invalide : en-tête de ${join(folder, "SKILL.md")}`);
  const files = readdirSync(folder)
    // Fichiers cachés (.DS_Store…) ignorés : jamais copiés dans une compétence.
    .filter((name) => name !== "SKILL.md" && !name.startsWith("."))
    .sort()
    .map((name) => ({ name, text: read(join(folder, name)) }));
  return { name: match[1]!.trim(), description: match[2]!.trim(), instructions: match[3]!.trimEnd(), ...(files.length ? { files } : {}) };
}

function agent(root: string, id: string): AgentTemplate {
  const folder = join(root, "agents", id);
  const { skills, measured, ...meta } = json(agentFile, join(folder, "agent.json"));
  if (meta.id !== id) throw new Error(`Catalogue invalide : ${id}/agent.json porte l'identifiant « ${meta.id} »`);
  const evals = join(folder, "evals");
  const cases = json(z.object({ cases: z.array(evalCase) }).strict(), join(evals, "cases.json")).cases;
  const documents = (items: z.infer<typeof evalDocument>[] | undefined) => items?.map((item) => ({ name: item.name, text: read(inside(evals, item.file)) }));
  return {
    ...meta,
    ...(meta.team ? { team: meta.team } : {}),
    instructions: read(join(folder, "instructions.md")).trimEnd(),
    skills: skills.map((name) => skill(join(folder, "skills", name))),
    evaluation: {
      cases: cases.map((item): TemplateEvalCase => {
        const { documents: docs, attachments, ...rest } = item;
        return { ...rest, ...(docs ? { documents: documents(docs)! } : {}), ...(attachments ? { attachments: documents(attachments)! } : {}) } as TemplateEvalCase;
      }),
      ...(measured ? { measured } : {}),
    },
  } as AgentTemplate;
}

export function loadCatalog(root = CATALOG_DIR): AgentTemplate[] {
  const order = json(z.object({ agents: z.array(z.string().regex(/^[a-z0-9-]+$/)) }).strict(), join(root, "catalog.json")).agents;
  // Un dossier oublié dans catalog.json serait invisible : refusé aussi.
  const folders = existsSync(join(root, "agents")) ? readdirSync(join(root, "agents")) : [];
  const missing = folders.filter((name) => !order.includes(name));
  if (missing.length) throw new Error(`Catalogue invalide : ${missing.join(", ")} absent(s) de catalog.json`);
  return order.map((id) => agent(root, id));
}
