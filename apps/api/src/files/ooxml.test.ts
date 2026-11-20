import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { strToU8, unzipSync, zipSync } from "fflate";
import { checkOoxml } from "./ooxml.js";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const TYPES = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;
const rels = (...items: string[]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;
const pkg = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries({ "[Content_Types].xml": TYPES, "word/document.xml": "<w:document/>", ...files }).map(([name, value]) => [name, typeof value === "string" ? strToU8(value) : value])));

describe("Fichiers Office produits par le code : contrôlés avant d'être donnés", () => {
  it("documents réels du bac à sable (graphique natif = classeur incorporé, sommaire, liens) : acceptés", () => {
    for (const name of ["chart.pptx", "report.docx", "table.xlsx"]) assert.deepEqual(checkOoxml(fixture(name)), { ok: true }, name);
    // Le graphique de la présentation porte bien un classeur incorporé (contrôlé à son tour).
    assert.ok(Object.keys(unzipSync(fixture("chart.pptx"))).some((name) => /\/embeddings\/.+\.xlsx$/.test(name)));
  });

  it("lien hypertexte web ou courriel : admis ; tout autre lien sortant : refusé", () => {
    const link = (type: string, target: string) => pkg({ "word/_rels/document.xml.rels": rels(`<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}" TargetMode="External"/>`) });
    assert.deepEqual(checkOoxml(link("hyperlink", "https://exemple.fr/page")), { ok: true });
    assert.deepEqual(checkOoxml(link("hyperlink", "mailto:contact@exemple.fr")), { ok: true });
    // Modèle distant (fuite d'identifiants réseau à l'ouverture), image distante (pistage), lien javascript:, partage réseau.
    assert.deepEqual(checkOoxml(link("attachedTemplate", "https://attaquant.example/modele.dotm")), { ok: false, reason: "external_link" });
    assert.deepEqual(checkOoxml(link("image", "https://pistage.example/pixel.png")), { ok: false, reason: "external_link" });
    assert.deepEqual(checkOoxml(link("hyperlink", "javascript:alert(1)")), { ok: false, reason: "external_link" });
    assert.deepEqual(checkOoxml(link("hyperlink", "file://serveur/partage")), { ok: false, reason: "external_link" });
    assert.deepEqual(checkOoxml(link("oleObject", "\\\\serveur\\partage\\x.bin")), { ok: false, reason: "external_link" });
  });

  it("macros, ActiveX, objets incorporés, exécutables, liaisons DDE : refusés", () => {
    assert.deepEqual(checkOoxml(pkg({ "word/vbaProject.bin": new Uint8Array([1, 2]) })), { ok: false, reason: "forbidden_part" });
    assert.deepEqual(checkOoxml(pkg({ "[Content_Types].xml": TYPES.replace("</Types>", `<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>`) })), { ok: false, reason: "macro" });
    assert.deepEqual(checkOoxml(pkg({ "word/activeX/activeX1.xml": "<ax/>" })), { ok: false, reason: "forbidden_part" });
    assert.deepEqual(checkOoxml(pkg({ "word/embeddings/oleObject1.bin": new Uint8Array([0]) })), { ok: false, reason: "forbidden_part" });
    // Seuls les réglages d'impression ont droit à un .bin, à leur place exacte.
    assert.deepEqual(checkOoxml(pkg({ "ppt/printerSettings/printerSettings1.bin": new Uint8Array([0]) })), { ok: true });
    assert.deepEqual(checkOoxml(pkg({ "ppt/printerSettings/../embeddings/x.bin": new Uint8Array([0]) })), { ok: false, reason: "forbidden_part" });
    assert.deepEqual(checkOoxml(pkg({ "ppt/media/printerSettings1.bin": new Uint8Array([0]) })), { ok: false, reason: "forbidden_part" });
    assert.deepEqual(checkOoxml(pkg({ "ppt/embeddings/rapport.docx": pkg({}) })), { ok: false, reason: "embedded_object" });
    assert.deepEqual(checkOoxml(pkg({ "xl/externalLinks/externalLink1.xml": "<externalLink/>" })), { ok: false, reason: "forbidden_part" });
    assert.deepEqual(checkOoxml(pkg({ "xl/worksheets/sheet1.xml": "<worksheet><ddeLink ddeService=\"cmd\"/></worksheet>" })), { ok: false, reason: "dde_or_link_field" });
    assert.deepEqual(checkOoxml(pkg({ "word/document.xml": `<w:document><w:instrText> INCLUDEPICTURE "https://pistage.example/x.png" </w:instrText></w:document>` })), { ok: false, reason: "dde_or_link_field" });
    // Classeur incorporé piégé (macro) : refusé lui aussi.
    assert.deepEqual(checkOoxml(pkg({ "ppt/embeddings/donnees.xlsx": pkg({ "xl/vbaProject.bin": new Uint8Array([1]) }) })), { ok: false, reason: "forbidden_part" });
  });

  it("archive invalide, sans manifeste ou démesurée : refusée", () => {
    assert.deepEqual(checkOoxml(new TextEncoder().encode("pas un zip")), { ok: false, reason: "not_a_package" });
    assert.deepEqual(checkOoxml(zipSync({ "word/document.xml": strToU8("<w:document/>") })), { ok: false, reason: "not_a_package" });
    const many = Object.fromEntries(Array.from({ length: 2_100 }, (_, index) => [`word/media/f${index}.xml`, "<x/>"]));
    assert.deepEqual(checkOoxml(pkg(many)), { ok: false, reason: "too_large" });
  });
});
