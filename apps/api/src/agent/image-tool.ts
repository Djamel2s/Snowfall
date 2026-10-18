import { z } from "zod";
import type { GeneratedFileMeta } from "../files/generated.js";
import type { MalwareScanner } from "../security/antivirus.js";
import { defineTool } from "./tools.js";

// Génération d'images par un modèle LOCAL (service auto-hébergé compatible avec
// l'API images d'OpenAI, ex. LocalAI ou un serveur diffusers sur le GPU) : la
// description ne quitte pas la plateforme. L'image suit la chaîne des fichiers
// produits par le code : signature PNG vérifiée, antivirus, chiffrée, affichée
// sous la réponse. Bornée : 4 images par réponse, quota mensuel « image ».

export interface ImageGenerator {
  generate(prompt: string, size: ImageSize, signal: AbortSignal): Promise<Buffer>;
}

export const imageSizes = ["1024x1024", "1024x1536", "1536x1024"] as const;
export type ImageSize = (typeof imageSizes)[number];
export const MAX_IMAGES_PER_ANSWER = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

const isPng = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

export class OpenAiCompatibleImages implements ImageGenerator {
  constructor(
    private readonly config: { baseUrl: string; model: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(prompt: string, size: ImageSize, signal: AbortSignal) {
    const response = await this.fetcher(`${this.config.baseUrl.replace(/\/$/, "")}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.model, prompt, n: 1, size, response_format: "b64_json" }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error("IMAGE_UNAVAILABLE");
    const body = (await response.json().catch(() => null)) as { data?: { b64_json?: unknown }[] } | null;
    const encoded = body?.data?.[0]?.b64_json;
    if (typeof encoded !== "string" || encoded.length > (MAX_IMAGE_BYTES * 4) / 3 + 4) throw new Error("IMAGE_INVALID");
    const bytes = Buffer.from(encoded, "base64");
    if (!isPng(bytes) || bytes.length > MAX_IMAGE_BYTES) throw new Error("IMAGE_INVALID");
    return bytes;
  }
}

export function imageTool(deps: {
  generator: ImageGenerator;
  scanner?: MalwareScanner | undefined;
  saveFile: (input: { name: string; mediaType: string; bytes: Buffer }) => Promise<GeneratedFileMeta>;
  images: { count: number };
}) {
  return defineTool({
    name: "generate_image",
    description:
      "Crée une image à partir d'une description, avec un modèle local (rien ne sort de la plateforme). " +
      "À utiliser quand l'utilisateur demande une illustration, un visuel ou une image. Décris précisément le sujet, " +
      "le style et la composition, en anglais de préférence. L'image s'affiche sous ta réponse : ne la décris pas en détail.",
    parameters: z
      .object({
        prompt: z.string().trim().min(3).max(1_000).describe("Description de l'image à créer."),
        size: z.enum(imageSizes).optional().describe("Format : carré (défaut), portrait ou paysage."),
      })
      .strict(),
    access: "read",
    async execute({ prompt, size }, { signal }) {
      if (deps.images.count >= MAX_IMAGES_PER_ANSWER) return { content: "Limite d'images atteinte pour cette réponse.", summary: "limite" };
      deps.images.count++;
      let bytes: Buffer;
      try {
        bytes = await deps.generator.generate(prompt, size ?? "1024x1024", signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return { content: "Génération d'image indisponible pour le moment.", summary: "indisponible" };
      }
      if (deps.scanner) {
        const scan = await deps.scanner.scan(bytes).catch(() => null);
        if (!scan?.clean) return { content: "Image refusée par l'analyse de sécurité.", summary: "refusée" };
      }
      const saved = await deps.saveFile({ name: "image.png", mediaType: "image/png", bytes });
      return { content: `Image créée (affichée sous ta réponse) : ${saved.name}.`, summary: "image créée", data: { files: [saved.id] } };
    },
  });
}
