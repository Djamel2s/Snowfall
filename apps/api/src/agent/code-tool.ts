import http from "node:http";
import { z } from "zod";
import { generatedFileMediaTypes, GENERATED_FILE_MAX_BYTES } from "../db/schema.js";
import type { GeneratedFileInput, GeneratedFileMeta } from "../files/generated.js";
import { checkOoxml, OOXML_TYPES } from "../files/ooxml.js";
import { knownNumbers, officeText, unsupportedNumbers } from "./fidelity.js";
import type { MalwareScanner } from "../security/antivirus.js";
import { sandboxPath } from "../skills/scripts.js";
import { defineTool } from "./tools.js";
import { localEndpoint, type LocalEndpoint } from "../security/local-endpoint.js";

// Interpréteur de code : le code écrit par le modèle s'exécute dans le bac à
// sable (apps/sandbox), un conteneur SANS réseau joint par un socket Unix.
// Le code n'atteint ni Internet, ni la base, ni l'API, ni les données d'une
// autre exécution. Les fichiers produits passent par l'antivirus puis sont
// stockés chiffrés, rattachés à la réponse.

export const MAX_RUNS = 5;
/** Délai d'une exécution : une conversion en PDF (LibreOffice) prend quelques secondes. */
export const CODE_SECONDS = 60;
const OUTPUT_TO_MODEL = 8_000;

export type SandboxResult = {
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  files: { name: string; mediaType: string; size: number; data: string }[];
};

/** Script d'une compétence : ses fichiers (copiés dans skill/), le script lancé et ses arguments. */
/** Chemins sous skill/ (la compétence) ou inputs/ (fichiers de l'utilisateur) ; texte, ou binaire en base64. */
export type SkillRunFile = { path: string; content: string } | { path: string; data: string };
export type SkillRun = { files: SkillRunFile[]; entry: string; args: string[] };

export interface CodeSandbox {
  run(code: string, options: { timeoutSeconds: number; signal: AbortSignal; skill?: SkillRun | undefined }): Promise<SandboxResult>;
}

/** Bac à sable par socket Unix (aucun port réseau ouvert). */
export class UnixSocketSandbox implements CodeSandbox {
  private readonly endpoint: LocalEndpoint;

  constructor(socketPath: string) {
    this.endpoint = localEndpoint(socketPath);
  }

  run(code: string, options: { timeoutSeconds: number; signal: AbortSignal; skill?: SkillRun | undefined }): Promise<SandboxResult> {
    const body = JSON.stringify(options.skill ? { ...options.skill, timeoutSeconds: options.timeoutSeconds } : { code, timeoutSeconds: options.timeoutSeconds });
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          ...this.endpoint,
          path: "/run",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: (options.timeoutSeconds + 30) * 1000,
          signal: options.signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            // Fichiers en base64 (12 Mo au plus côté bac à sable) : borne de sécurité.
            if (size > 20 * 1024 * 1024) request.destroy(new Error("SANDBOX_RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            if (response.statusCode === 429) return reject(new Error("SANDBOX_BUSY"));
            if (response.statusCode !== 200) return reject(new Error(`SANDBOX_${response.statusCode}`));
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as SandboxResult);
            } catch {
              reject(new Error("SANDBOX_INVALID_RESPONSE"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("SANDBOX_TIMEOUT")));
      request.on("error", reject);
      request.end(body);
    });
  }
}

const shorten = (text: string) => (text.length > OUTPUT_TO_MODEL ? `${text.slice(0, OUTPUT_TO_MODEL)}\n[… tronqué]` : text);

/** Nom de fichier lisible et sûr (aucun chemin). */
const safeName = (name: string) => name.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 120) || "fichier";

export type SandboxDeps = {
  sandbox: CodeSandbox;
  scanner?: MalwareScanner | undefined;
  /** Enregistre un fichier produit (chiffré), pour la réponse en cours. */
  saveFile: (input: GeneratedFileInput) => Promise<GeneratedFileMeta>;
  /** Exécutions de la réponse (code du modèle et scripts de compétence : même plafond). */
  runs: { count: number };
};

/** Fichiers copiés dans le bac à sable : sous sa limite (8 Mio, base64 compris). */
export const SANDBOX_INPUT_BYTES = 7_500_000;
/** Fichiers de l'utilisateur transmis à une exécution, au plus. */
export const MAX_SCRIPT_INPUTS = 5;

/** Fichiers de la conversation (pièces jointes), retrouvés par leur nom. */
export type ScriptInputs = (names: string[]) => Promise<{ name: string; bytes: Buffer }[]>;

/**
 * Pièces jointes demandées, cherchées dans CETTE conversation seulement, copiées
 * sous inputs/ (noms rendus sûrs ; un chemin déjà pris ou un total trop lourd :
 * le fichier est signalé manquant). Ajoute aux `files` ; renvoie le nouveau total.
 */
export async function copyInputs(wanted: string[], inputs: ScriptInputs | undefined, files: SkillRunFile[], total: number) {
  const copied: string[] = [];
  const missing: string[] = [];
  const free = (path: string) => !files.some((other) => other.path === path || other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`));
  const names = [...new Set(wanted)];
  const found = names.length && inputs ? await inputs(names) : [];
  for (const name of names) {
    const input = found.find((item) => item.name === name);
    const relative = sandboxPath(name.replace(/\//g, "_"));
    const path = relative && `inputs/${relative}`;
    const data = input?.bytes.toString("base64");
    if (!input || !path || !free(path) || !data || total + data.length > SANDBOX_INPUT_BYTES) {
      missing.push(name);
      continue;
    }
    total += data.length;
    files.push({ path, data });
    copied.push(path);
  }
  const notes = [
    ...(copied.length ? [`Pièces jointes copiées : ${copied.join(", ")}.`] : []),
    ...(missing.length ? [`Fichiers introuvables dans la conversation (ou trop lourds) : ${missing.join(", ")}.`] : []),
  ];
  return { total, copied: copied.length, note: notes.join("\n") };
}

export const RUNS_EXHAUSTED = "Limite d'exécutions atteinte pour cette réponse : conclus avec ce que tu as.";

/**
 * Résultat d'une exécution, pour le modèle : fichiers produits passés à
 * l'antivirus puis enregistrés (chiffrés), sorties tronquées.
 */
export async function deliverRun(result: SandboxResult, deps: Pick<SandboxDeps, "scanner" | "saveFile">, known?: number[]) {
  // Date du jour : une source légitime (« au 19 novembre »), admise telle quelle.
  const today = new Date();
  const saved: GeneratedFileMeta[] = [];
  const unsupported: { file: string; numbers: string[] }[] = [];
  const refused: string[] = [];
  for (const file of result.files.slice(0, 8)) {
    const bytes = Buffer.from(file.data, "base64");
    const allowed = (generatedFileMediaTypes as readonly string[]).includes(file.mediaType);
    if (!allowed || bytes.length === 0 || bytes.length > GENERATED_FILE_MAX_BYTES) {
      refused.push(file.name);
      continue;
    }
    // Word, PowerPoint, Excel : ni macro, ni objet incorporé, ni lien sortant (hors liens hypertextes).
    if (OOXML_TYPES.has(file.mediaType) && !checkOoxml(bytes).ok) {
      refused.push(file.name);
      continue;
    }
    // Même règle que tout fichier entrant : antivirus, refus si indisponible.
    if (deps.scanner) {
      const scan = await deps.scanner.scan(bytes).catch(() => null);
      if (!scan?.clean) {
        refused.push(file.name);
        continue;
      }
    }
    // Fidélité : chiffres du document absents de ce que le modèle a reçu (ni déduits).
    // Gardés avec le fichier : la carte du fichier les montre à la personne.
    const numbers = known && OOXML_TYPES.has(file.mediaType) ? unsupportedNumbers(officeText(bytes), known, { exact: [today.getDate(), today.getMonth() + 1] }) : [];
    if (numbers.length) unsupported.push({ file: safeName(file.name), numbers });
    saved.push(await deps.saveFile({ name: safeName(file.name), mediaType: file.mediaType, bytes, ...(numbers.length ? { review: numbers } : {}) }));
  }

  const status = result.timedOut ? "délai dépassé" : result.exitCode === 0 ? "terminé" : `erreur (code ${result.exitCode})`;
  const parts = [`Exécution ${status} en ${(result.durationMs / 1000).toFixed(1)} s.`];
  if (result.stdout.trim()) parts.push(`Sortie :\n${shorten(result.stdout)}`);
  if (result.stderr.trim()) parts.push(`Erreurs :\n${shorten(result.stderr)}`);
  if (saved.length) parts.push(`Fichiers donnés à l'utilisateur (affichés sous ta réponse) : ${saved.map((file) => file.name).join(", ")}.`);
  if (refused.length) parts.push(`Fichiers refusés (type, taille ou analyse) : ${refused.join(", ")}.`);
  // En tête : placée après la sortie du script, l'alerte était ignorée (mesuré le 20 novembre).
  for (const item of unsupported.reverse()) {
    parts.unshift(
      `À FAIRE AVANT DE RÉPONDRE — contrôle de fidélité : ${item.file} contient des nombres absents de la demande, des pièces jointes et des résultats d'outils ` +
        `(et qui ne s'en déduisent pas) : ${item.numbers.join(", ")}. S'ils sont inventés, retire-les ou remplace-les et relance le code ; ` +
        `s'ils sont justes, dis d'où ils viennent dans ta réponse.`,
    );
  }
  return {
    content: parts.join("\n\n"),
    summary: (saved.length ? `${status} · ${saved.length} fichier(s)` : status) + (unsupported.length ? ` · chiffres à vérifier : ${unsupported.flatMap((item) => item.numbers).slice(0, 8).join(", ")}` : ""),
    data: { files: saved.map((file) => file.id), ...(unsupported.length ? { unsupported } : {}) },
  };
}

export function codeTool(deps: SandboxDeps & { inputs?: ScriptInputs | undefined }) {
  return defineTool({
    name: "run_code",
    description:
      "Exécute du code Python 3.13 dans un bac à sable isolé, SANS accès au réseau. " +
      (deps.inputs
        ? "Les fichiers de la conversation nommés dans « files » (pièces jointes, images créées, fichiers produits) sont copiés dans inputs/ : " +
          "lis-les depuis ce dossier (ex. pd.read_csv(\"inputs/ventes.csv\"), pdf.image(\"inputs/image-1.png\")) plutôt que de recopier leurs données dans le code. "
        : "Il n'a pas accès aux fichiers de l'utilisateur. ") +
      "Documents soignés (présentation, rapport Word, classeur Excel, PDF) : module snowfall_docs (Deck, Report, Workbook, Theme, to_pdf, " +
      "fill_template) ; lis d'abord son mode d'emploi complet, en une seule exécution : print(snowfall_docs.guide()) ; " +
      "et suis-le (thème cohérent, titres qui donnent la conclusion, mises en page variées). Il suit aussi un modèle fourni par l'utilisateur. " +
      "Dans un document, n'invente aucun chiffre, délai, répartition ni source absents de la demande ou des fichiers : un document plus court vaut mieux. " +
      "Autres bibliothèques : numpy, pandas, matplotlib, openpyxl, python-docx, python-pptx, xlsxwriter, pillow, fpdf2, pypdf " +
      "et la bibliothèque standard. Utilise-le pour calculer, analyser des données, faire un graphique ou produire un fichier. Affiche les résultats avec print(). Pour donner un fichier à " +
      "l'utilisateur, enregistre-le dans le dossier courant (ex. plt.savefig(\"graphique.png\"), df.to_csv(\"donnees.csv\")) : " +
      "png, jpg, svg, csv, txt, md, json, xlsx, docx, pptx, pdf (5 Mo par fichier). Chaque exécution repart de zéro (aucun état conservé). " +
      "Délai : 60 s. Si l'exécution échoue, lis l'erreur, corrige et réessaie.",
    parameters: z
      .object({
        code: z.string().min(1).max(50_000).describe("Programme Python complet."),
        files: z
          .array(z.string().min(1).max(120))
          .max(MAX_SCRIPT_INPUTS)
          .default([])
          .describe("Noms exacts de fichiers de la conversation (pièces jointes, images créées) à copier dans inputs/."),
      })
      .strict(),
    access: "read",
    grounded: true,
    // Au-delà du délai commun des outils (30 s) : l'exécution elle-même dure jusqu'à CODE_SECONDS.
    timeoutMs: (CODE_SECONDS + 15) * 1000,
    async execute({ code, files: wanted }, { signal, known }) {
      if (deps.runs.count >= MAX_RUNS) return { content: RUNS_EXHAUSTED, summary: "limite" };
      if (!wanted.length) {
        deps.runs.count++;
        return deliverRun(await deps.sandbox.run(code, { timeoutSeconds: CODE_SECONDS, signal }), deps, known);
      }
      // Avec des fichiers : même chemin que les scripts de compétence (code dans skill/,
      // fichiers dans inputs/, jamais rendus comme résultats). Le bac à sable ne change pas.
      const files: SkillRunFile[] = [{ path: "skill/main.py", content: code }];
      const { note, copied } = await copyInputs(wanted, deps.inputs, files, Buffer.byteLength(code, "utf8"));
      deps.runs.count++;
      // Les fichiers fournis (un CSV de ventes…) sont des sources : leurs nombres aussi.
      const provided = known && [...known, ...files.filter((file) => file.path.startsWith("inputs/")).flatMap((file) => inputNumbers(file))];
      const result = await deliverRun(await deps.sandbox.run("", { timeoutSeconds: CODE_SECONDS, signal, skill: { files, entry: "skill/main.py", args: [] } }), deps, provided);
      // `inputs` : la sortie dérive d'un fichier de l'utilisateur (non fiable ET privé), comme
      // une pièce jointe — même si celle-ci n'est plus dans la fenêtre (règle de deux, exposure.ts).
      return { ...result, content: `${note}\n\n${result.content}`, data: { ...result.data, inputs: copied } };
    },
  });
}

/** Nombres d'un fichier fourni au code : texte (CSV, JSON…) ou document Office. */
function inputNumbers(file: SkillRunFile): number[] {
  if ("content" in file) return knownNumbers(file.content);
  const bytes = Buffer.from(file.data, "base64");
  if (bytes.subarray(0, 2).toString("latin1") === "PK") return knownNumbers(officeText(bytes));
  const text = bytes.toString("utf8");
  if (/\.(csv|tsv)$/i.test(file.path)) {
    // Une cellule par ligne : « mineur,4 » n'est pas le nombre « ,4 ». Point-virgule (CSV français), sinon virgule ou tabulation.
    const separator = text.includes(";") ? ";" : /\.tsv$/i.test(file.path) || text.includes("\t") ? "\t" : ",";
    return knownNumbers(text.split(/\r?\n/).flatMap((line) => line.split(separator)).map((cell) => cell.replace(/^"|"$/g, "")).join("\n"));
  }
  return /\.(txt|md|json)$/i.test(file.path) ? knownNumbers(text) : [];
}

/** Identifiants des fichiers produits pendant une réponse (pour les rattacher à son message). */
export function generatedFileIds(turns: { role: string; name?: string; data?: unknown }[]) {
  return turns.flatMap((turn) =>
    turn.role === "tool" && (turn.name === "run_code" || turn.name === "run_skill_script" || turn.name === "generate_image") && turn.data && typeof turn.data === "object" && Array.isArray((turn.data as { files?: unknown }).files)
      ? ((turn.data as { files: unknown[] }).files.filter((id): id is string => typeof id === "string"))
      : [],
  );
}
