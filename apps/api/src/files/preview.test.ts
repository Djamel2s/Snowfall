import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodeSandbox, SkillRun } from "../agent/code-tool.js";
import type { AuthenticatedUser } from "../auth/auth.js";
import type { DocumentOcr } from "../ocr/client.js";
import { createAppServer } from "../server.js";
import { createFakeConversationStore } from "../testing/fakes.js";
import { MemoryGeneratedFileStore } from "./generated.js";
import { FilePreviewer, PreviewError } from "./preview.js";

// Aperçu d'un document produit : pages en images, conversion et rendu dans des
// services sans réseau ; jamais le fichier d'une autre personne ; jamais de code
// venu d'un modèle dans le bac à sable.

const ORIGIN = "http://localhost:5173";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("page")]);
const PDF = Buffer.from("%PDF-1.7 converti");
const signal = new AbortController().signal;

function fakes(options: { sandboxExit?: number; busy?: boolean } = {}) {
  const runs: { code: string; skill?: SkillRun | undefined }[] = [];
  const rendered: Buffer[] = [];
  const sandbox: CodeSandbox = {
    run: async (code, { skill }) => {
      runs.push({ code, skill });
      if (options.busy) throw new Error("SANDBOX_BUSY");
      return { exitCode: options.sandboxExit ?? 0, timedOut: false, durationMs: 900, stdout: "", stderr: "", files: [{ name: "apercu.pdf", mediaType: "application/pdf", size: PDF.length, data: PDF.toString("base64") }] };
    },
  };
  const ocr: DocumentOcr = {
    recognize: async () => "",
    render: async (pdf) => {
      rendered.push(pdf);
      return { pages: [PNG, PNG], total: 7 };
    },
  };
  return { sandbox, ocr, runs, rendered };
}

describe("Aperçu des documents : conversion et rendu", () => {
  it("Word : converti par un script FIXE dans le bac à sable, puis rendu en pages", async () => {
    const { sandbox, ocr, runs, rendered } = fakes();
    const pages = await new FilePreviewer({ sandbox, ocr }).render({ mediaType: DOCX, bytes: Buffer.from("PK docx") }, signal);
    assert.deepEqual(pages, { pages: [PNG, PNG], total: 7 });
    assert.equal(runs.length, 1);
    // Aucun code libre : seulement le script de la plateforme, le document en entrée.
    assert.equal(runs[0]!.code, "");
    assert.equal(runs[0]!.skill?.entry, "skill/apercu.py");
    assert.deepEqual(runs[0]!.skill?.args, ["inputs/document.docx"]);
    assert.match(JSON.stringify(runs[0]!.skill?.files[0]), /from snowfall_docs import to_pdf/);
    assert.deepEqual(rendered, [PDF]);
  });

  it("PDF : rendu directement, sans le bac à sable", async () => {
    const { sandbox, ocr, runs, rendered } = fakes();
    await new FilePreviewer({ sandbox, ocr }).render({ mediaType: "application/pdf", bytes: Buffer.from("%PDF-1.4") }, signal);
    assert.equal(runs.length, 0);
    assert.equal(rendered.length, 1);
  });

  it("formats et services : CSV sans aperçu ; sans OCR, rien ; sans bac à sable, PDF seulement", async () => {
    const { sandbox, ocr } = fakes();
    const full = new FilePreviewer({ sandbox, ocr });
    assert.equal(full.supports("text/csv"), false);
    assert.equal(full.supports("image/png"), false);
    assert.equal(new FilePreviewer({ sandbox }).available(DOCX), false);
    const noSandbox = new FilePreviewer({ ocr });
    assert.equal(noSandbox.available("application/pdf"), true);
    assert.equal(noSandbox.available(DOCX), false);
    await assert.rejects(() => noSandbox.render({ mediaType: DOCX, bytes: Buffer.from("x") }, signal), (error: unknown) => error instanceof PreviewError && error.reason === "unavailable");
  });

  it("échecs : conversion ratée, bac à sable occupé", async () => {
    const failed = fakes({ sandboxExit: 1 });
    await assert.rejects(() => new FilePreviewer(failed).render({ mediaType: DOCX, bytes: Buffer.from("x") }, signal), (error: unknown) => error instanceof PreviewError && error.reason === "failed");
    const busy = fakes({ busy: true });
    await assert.rejects(() => new FilePreviewer(busy).render({ mediaType: DOCX, bytes: Buffer.from("x") }, signal), (error: unknown) => error instanceof PreviewError && error.reason === "busy");
  });
});

describe("Aperçu des documents : route", () => {
  const alice: AuthenticatedUser = { userId: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", role: "member" };
  const bob: AuthenticatedUser = { ...alice, userId: "33333333-3333-4333-8333-333333333333" };
  const conversation = "44444444-4444-4444-8444-444444444444";

  async function setup(withServices = true) {
    const files = new MemoryGeneratedFileStore();
    const services = fakes();
    let current = alice;
    const app = createAppServer({
      appOrigin: ORIGIN,
      logger: false,
      conversationStore: createFakeConversationStore(),
      authenticate: async () => current,
      generatedFiles: files,
      ...(withServices ? { sandbox: services.sandbox, ocr: services.ocr } : {}),
    });
    const docx = await files.create(alice, conversation, { name: "rapport.docx", mediaType: DOCX, bytes: Buffer.from("PK docx") });
    const csv = await files.create(alice, conversation, { name: "ventes.csv", mediaType: "text/csv", bytes: Buffer.from("a,b") });
    const get = (user: AuthenticatedUser, fileId: string, conversationId = conversation) => {
      current = user;
      return app.inject({ method: "GET", url: `/conversations/${conversationId}/files/${fileId}/preview` });
    };
    return { get, docx, csv, services };
  }

  it("son document : pages PNG en base64, nombre total de pages ; calculé une seule fois", async () => {
    const { get, docx, services } = await setup();
    const response = await get(alice, docx.id);
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["cache-control"]), /no-store/);
    const body = response.json() as { pages: string[]; total: number };
    assert.equal(body.total, 7);
    assert.ok(Buffer.from(body.pages[0]!, "base64").equals(PNG));
    await get(alice, docx.id);
    assert.equal(services.runs.length, 1);
  });

  it("le document d'une autre personne, ou d'une autre conversation : introuvable, rien n'est converti", async () => {
    const { get, docx, services } = await setup();
    assert.equal((await get(bob, docx.id)).statusCode, 404);
    assert.equal((await get(alice, docx.id, "55555555-5555-4555-8555-555555555555")).statusCode, 404);
    assert.equal(services.runs.length, 0);
  });

  it("format sans aperçu : 415 ; services absents : 503 (le téléchargement reste possible)", async () => {
    const { get, csv } = await setup();
    assert.equal((await get(alice, csv.id)).json().reason, "preview_unsupported");
    const bare = await setup(false);
    const response = await bare.get(alice, bare.docx.id);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().reason, "preview_unavailable");
  });
});
