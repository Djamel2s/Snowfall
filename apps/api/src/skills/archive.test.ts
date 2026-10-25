import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { cleanPath, parseSkillMarkdown, readZip, SkillArchiveError, splitSkillArchive } from "./archive.js";

const skillMd = "---\nname: note-de-synthese\ndescription: >\n  Rédiger une note de synthèse juridique,\n  quand on la demande.\n---\n\n# Méthode\n\n1. Faits.\n2. Règles.\n";
const code = (error: unknown, expected: SkillArchiveError["code"]) => error instanceof SkillArchiveError && error.code === expected;

describe("Import de compétence (zip)", () => {
  it("SKILL.md : en-tête lu (bloc replié compris), corps = instructions", () => {
    assert.deepEqual(parseSkillMarkdown(skillMd), {
      name: "note-de-synthese",
      description: "Rédiger une note de synthèse juridique, quand on la demande.",
      instructions: "# Méthode\n\n1. Faits.\n2. Règles.",
    });
    assert.equal(parseSkillMarkdown('---\nname: "x"\ndescription: \'Quand y\'\n---\nCorps').description, "Quand y");
    assert.throws(() => parseSkillMarkdown("# Pas d'en-tête"), (error) => code(error, "invalid_skill_md"));
    assert.throws(() => parseSkillMarkdown("---\nname: x\n---\nsans description"), (error) => code(error, "invalid_skill_md"));
  });

  it("dossier de premier niveau retiré, fichiers cachés et __MACOSX ignorés, chemins nettoyés", () => {
    const zip = zipSync({
      "note/SKILL.md": strToU8(skillMd),
      "note/references/plan.md": strToU8("# Plan"),
      "note/.DS_Store": strToU8("x"),
      "__MACOSX/note/._plan.md": strToU8("x"),
    });
    const { skill, others } = splitSkillArchive(readZip(zip));
    assert.equal(skill.name, "note-de-synthese");
    assert.deepEqual(others.map((entry) => entry.path), ["references/plan.md"]);
    assert.equal(cleanPath("../../etc/passwd"), "etc/passwd");
    assert.equal(cleanPath("a\\..\\b\u0000.md"), "a/b.md");
  });

  it("zip bomb : arrêt sur les octets réellement décompressés ; trop d'entrées ; pas de SKILL.md ; pas un zip", () => {
    const bomb = zipSync({ "SKILL.md": strToU8(skillMd), "zeros.txt": new Uint8Array(12 * 1024 * 1024) }, { level: 9 });
    assert.ok(bomb.length < 100_000, "petit à l'envoi");
    assert.throws(() => readZip(bomb), (error) => code(error, "too_large"));
    const many = zipSync(Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`f${index}.txt`, strToU8("x")])));
    assert.throws(() => readZip(many), (error) => code(error, "too_many_entries"));
    assert.throws(() => splitSkillArchive(readZip(zipSync({ "README.md": strToU8("x") }))), (error) => code(error, "missing_skill_md"));
    assert.throws(() => readZip(strToU8("PK\u0003\u0004 pas vraiment un zip")), SkillArchiveError);
  });
});
