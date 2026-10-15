import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCX, detectFile, sanitizeFileName } from "./detect.js";
import { extractText } from "./extract.js";
import { makeDocx, makePdf, makeZip } from "./fixtures.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("Pièces jointes : détection du type réel", () => {
  it("reconnaît PDF, DOCX, images et texte par leur contenu", () => {
    assert.deepEqual(detectFile(makePdf("x"), "a.pdf"), { kind: "document", mediaType: "application/pdf" });
    assert.deepEqual(detectFile(makeDocx(["x"]), "a.docx"), { kind: "document", mediaType: DOCX });
    assert.deepEqual(detectFile(PNG, "photo.jpg"), { kind: "image", mediaType: "image/png" });
    assert.deepEqual(detectFile(Buffer.from("a,b\n1,2"), "data.csv"), { kind: "document", mediaType: "text/csv" });
  });

  it("refuse SVG, HTML, exécutables, ZIP quelconques et faux PDF", () => {
    for (const [bytes, name] of [
      [Buffer.from('<svg onload="alert(1)"/>'), "image.svg"],
      [Buffer.from("<html><script>alert(1)</script>"), "page.html"],
      [Buffer.from("MZ\x90\x00"), "setup.exe"],
      [makeZip({ "evil.js": "alert(1)" }), "archive.docx"],
      [Buffer.from("pas un pdf"), "faux.pdf"],
      [Buffer.from([0xff, 0xfe, 0x00, 0x41]), "binaire.txt"],
    ] as const) {
      assert.equal(detectFile(Buffer.from(bytes), name), null, name);
    }
  });

  it("nettoie le nom de fichier", () => {
    assert.equal(sanitizeFileName("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFileName('C:\\x\\rapport<script>".pdf'), "rapportscript.pdf");
    assert.equal(sanitizeFileName("\u0000"), "fichier");
  });
});

describe("Pièces jointes : extraction du texte", () => {
  it("extrait le texte d'un PDF dans un worker isolé", async () => {
    const text = await extractText(makePdf("Bonjour Snowfall"), "application/pdf");
    assert.match(text, /Bonjour Snowfall/);
  });

  it("extrait les paragraphes d'un DOCX et décode les entités XML", async () => {
    const text = await extractText(makeDocx(["Contrat &amp; annexes", "Article 2"]), DOCX);
    assert.match(text, /Contrat & annexes\nArticle 2/);
  });

  it("refuse une bombe ZIP au lieu de saturer la mémoire", async () => {
    const bomb = makeDocx(["x".repeat(40 * 1024 * 1024)]);
    assert.ok(bomb.length < 1024 * 1024);
    await assert.rejects(extractText(bomb, DOCX), /EXTRACTION_FAILED/);
  });

  it("un PDF corrompu échoue proprement", async () => {
    await assert.rejects(extractText(Buffer.from("%PDF-1.4 n'importe quoi"), "application/pdf"), /EXTRACTION/);
  });
});
