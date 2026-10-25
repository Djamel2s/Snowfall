import http from "node:http";
import { z } from "zod";
import { generatedFileMediaTypes, GENERATED_FILE_MAX_BYTES } from "../db/schema.js";
import type { GeneratedFileMeta } from "../files/generated.js";
import type { MalwareScanner } from "../security/antivirus.js";
import { defineTool } from "./tools.js";

// Interpréteur de code : le code écrit par le modèle s'exécute dans le bac à
// sable (apps/sandbox), un conteneur SANS réseau joint par un socket Unix.
// Le code n'atteint ni Internet, ni la base, ni l'API, ni les données d'une
// autre exécution. Les fichiers produits passent par l'antivirus puis sont
// stockés chiffrés, rattachés à la réponse.

export const MAX_RUNS = 5;
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
export type SkillRun = { files: { path: string; content: string }[]; entry: string; args: string[] };

export interface CodeSandbox {
  run(code: string, options: { timeoutSeconds: number; signal: AbortSignal; skill?: SkillRun | undefined }): Promise<SandboxResult>;
}

/** Bac à sable par socket Unix (aucun port réseau ouvert). */
export class UnixSocketSandbox implements CodeSandbox {
  constructor(private readonly socketPath: string) {}

  run(code: string, options: { timeoutSeconds: number; signal: AbortSignal; skill?: SkillRun | undefined }): Promise<SandboxResult> {
    const body = JSON.stringify(options.skill ? { ...options.skill, timeoutSeconds: options.timeoutSeconds } : { code, timeoutSeconds: options.timeoutSeconds });
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.socketPath,
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
  saveFile: (input: { name: string; mediaType: string; bytes: Buffer }) => Promise<GeneratedFileMeta>;
  /** Exécutions de la réponse (code du modèle et scripts de compétence : même plafond). */
  runs: { count: number };
};

export const RUNS_EXHAUSTED = "Limite d'exécutions atteinte pour cette réponse : conclus avec ce que tu as.";

/**
 * Résultat d'une exécution, pour le modèle : fichiers produits passés à
 * l'antivirus puis enregistrés (chiffrés), sorties tronquées.
 */
export async function deliverRun(result: SandboxResult, deps: Pick<SandboxDeps, "scanner" | "saveFile">) {
  const saved: GeneratedFileMeta[] = [];
  const refused: string[] = [];
  for (const file of result.files.slice(0, 8)) {
    const bytes = Buffer.from(file.data, "base64");
    const allowed = (generatedFileMediaTypes as readonly string[]).includes(file.mediaType);
    if (!allowed || bytes.length === 0 || bytes.length > GENERATED_FILE_MAX_BYTES) {
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
    saved.push(await deps.saveFile({ name: safeName(file.name), mediaType: file.mediaType, bytes }));
  }

  const status = result.timedOut ? "délai dépassé" : result.exitCode === 0 ? "terminé" : `erreur (code ${result.exitCode})`;
  const parts = [`Exécution ${status} en ${(result.durationMs / 1000).toFixed(1)} s.`];
  if (result.stdout.trim()) parts.push(`Sortie :\n${shorten(result.stdout)}`);
  if (result.stderr.trim()) parts.push(`Erreurs :\n${shorten(result.stderr)}`);
  if (saved.length) parts.push(`Fichiers donnés à l'utilisateur (affichés sous ta réponse) : ${saved.map((file) => file.name).join(", ")}.`);
  if (refused.length) parts.push(`Fichiers refusés (type, taille ou analyse) : ${refused.join(", ")}.`);
  return {
    content: parts.join("\n\n"),
    summary: saved.length ? `${status} · ${saved.length} fichier(s)` : status,
    data: { files: saved.map((file) => file.id) },
  };
}

export function codeTool(deps: SandboxDeps) {
  return defineTool({
    name: "run_code",
    description:
      "Exécute du code Python 3.13 dans un bac à sable isolé, SANS accès au réseau ni aux fichiers de l'utilisateur. " +
      "Bibliothèques : numpy, pandas, matplotlib, openpyxl (et la bibliothèque standard). Utilise-le pour calculer, analyser " +
      "des données, faire un graphique ou produire un fichier. Affiche les résultats avec print(). Pour donner un fichier à " +
      "l'utilisateur, enregistre-le dans le dossier courant (ex. plt.savefig(\"graphique.png\"), df.to_csv(\"donnees.csv\")) : " +
      "png, jpg, svg, csv, txt, md, json, xlsx, pdf. Chaque exécution repart de zéro (aucun état conservé). Délai : 30 s.",
    parameters: z
      .object({
        code: z.string().min(1).max(50_000).describe("Programme Python complet."),
      })
      .strict(),
    access: "read",
    async execute({ code }, { signal }) {
      if (deps.runs.count >= MAX_RUNS) return { content: RUNS_EXHAUSTED, summary: "limite" };
      deps.runs.count++;
      return deliverRun(await deps.sandbox.run(code, { timeoutSeconds: 30, signal }), deps);
    },
  });
}

/** Identifiants des fichiers produits pendant une réponse (pour les rattacher à son message). */
export function generatedFileIds(turns: { role: string; name?: string; data?: unknown }[]) {
  return turns.flatMap((turn) =>
    turn.role === "tool" && (turn.name === "run_code" || turn.name === "run_skill_script" || turn.name === "generate_image") && turn.data && typeof turn.data === "object" && Array.isArray((turn.data as { files?: unknown }).files)
      ? ((turn.data as { files: unknown[] }).files.filter((id): id is string => typeof id === "string"))
      : [],
  );
}
