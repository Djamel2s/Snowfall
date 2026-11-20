import type { CodeSandbox } from "../agent/code-tool.js";
import type { DocumentOcr } from "../ocr/client.js";

// Aperçu d'un document produit par un agent (Word, PowerPoint, Excel, PDF) :
// les premières pages en IMAGES, jamais le fichier lui-même dans le navigateur.
// Un document Office ou un PDF peut porter du contenu actif (scripts PDF, objets
// incorporés, liens) ; une image n'exécute rien.
//
// 1. Office → PDF dans le bac à sable (LibreOffice ; aucun réseau, gVisor) ;
// 2. PDF → PNG dans le service OCR (Poppler ; aucun réseau, utilisateur dédié).
// Rien ne sort de l'infrastructure. Les pages restent en mémoire, brièvement
// (cache borné), jamais en base.

const OFFICE: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};
const PDF = "application/pdf";

/** Script fixe lancé dans le bac à sable : jamais de code venu d'un modèle ou d'un utilisateur. */
const CONVERT = [
  "import os, shutil, sys",
  "from snowfall_docs import to_pdf",
  "source = sys.argv[1]",
  'target = "apercu" + os.path.splitext(source)[1]',
  "shutil.copy(source, target)",
  "to_pdf(target)",
  "os.remove(target)",
].join("\n");

const CONVERT_SECONDS = 60;

export class PreviewError extends Error {
  constructor(readonly reason: "unsupported" | "unavailable" | "busy" | "failed") {
    super(`PREVIEW_${reason.toUpperCase()}`);
  }
}

export type PreviewPages = { pages: Buffer[]; total: number };

export class FilePreviewer {
  constructor(private readonly deps: { sandbox?: CodeSandbox | undefined; ocr?: DocumentOcr | undefined }) {}

  /** Format qui a un aperçu (les images s'affichent déjà telles quelles). */
  supports(mediaType: string) {
    return mediaType === PDF || mediaType in OFFICE;
  }

  /** Services nécessaires présents : OCR (rendu), plus le bac à sable pour un document Office. */
  available(mediaType: string) {
    if (!this.deps.ocr?.render) return false;
    return mediaType === PDF || Boolean(this.deps.sandbox);
  }

  async render(file: { mediaType: string; bytes: Buffer }, signal: AbortSignal): Promise<PreviewPages> {
    if (!this.supports(file.mediaType)) throw new PreviewError("unsupported");
    if (!this.available(file.mediaType) || !this.deps.ocr?.render) throw new PreviewError("unavailable");
    const pdf = file.mediaType === PDF ? file.bytes : await this.toPdf(file.bytes, OFFICE[file.mediaType]!, signal);
    try {
      const rendered = await this.deps.ocr.render(pdf);
      if (!rendered.pages.length) throw new PreviewError("failed");
      return rendered;
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      throw new PreviewError(error instanceof Error && error.message === "OCR_429" ? "busy" : "failed");
    }
  }

  private async toPdf(bytes: Buffer, extension: string, signal: AbortSignal) {
    const result = await this.deps
      .sandbox!.run("", {
        timeoutSeconds: CONVERT_SECONDS,
        signal,
        skill: {
          files: [
            { path: "skill/apercu.py", content: CONVERT },
            { path: `inputs/document${extension}`, data: bytes.toString("base64") },
          ],
          entry: "skill/apercu.py",
          args: [`inputs/document${extension}`],
        },
      })
      .catch((error: unknown) => {
        throw new PreviewError(error instanceof Error && error.message === "SANDBOX_BUSY" ? "busy" : "failed");
      });
    const pdf = result.files.find((item) => item.mediaType === PDF);
    if (result.exitCode !== 0 || !pdf) throw new PreviewError("failed");
    return Buffer.from(pdf.data, "base64");
  }
}
