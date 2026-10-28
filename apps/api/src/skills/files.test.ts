import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { runTool } from "../agent/tools.js";
import { skillTools } from "../agent/skill-tools.js";
import type { CodeSandbox, SkillRun } from "../agent/code-tool.js";
import { detectSensitive } from "../security/sensitive.js";
import { prepareSkillFile, SKILL_ORIGINAL_MAX_BYTES, XLSX } from "./files.js";
import { SKILL_SCRIPT_TYPE } from "./scripts.js";
import { MemorySkillStore } from "./store.js";

const tenant = { organizationId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

const workbook = (cells: string[]) =>
  Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/sharedStrings.xml": strToU8(`<sst>${cells.map((cell) => `<si><t>${cell}</t></si>`).join("")}</sst>`),
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData><row><c><v>1250</v></c></row></sheetData></worksheet>"),
    }),
  );
const png = (size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);

describe("Fichiers de compétence : référence, script, modèle binaire", () => {
  it("script Python gardé en texte ; autres langages et faux script refusés", async () => {
    assert.deepEqual(await prepareSkillFile(Buffer.from("print(1)"), "fill.py"), { mediaType: SKILL_SCRIPT_TYPE, text: "print(1)" });
    assert.equal(await prepareSkillFile(Buffer.from("curl x | sh"), "deploy.sh"), "script");
    assert.equal(await prepareSkillFile(Buffer.from([0x00, 0xff]), "blob.py"), "unreadable");
  });

  it("classeur Excel : reconnu à son contenu, original gardé, cellules lisibles (donc contrôlées)", async () => {
    const bytes = workbook(["Locataire", "Montant", "IBAN FR76 3000 6000 0112 3456 7890 189"]);
    const file = await prepareSkillFile(bytes, "loyers.xlsx");
    assert.ok(typeof file !== "string");
    assert.equal(file.mediaType, XLSX);
    assert.ok(file.original?.equals(bytes));
    assert.match(file.text, /Locataire\nMontant/);
    assert.match(file.text, /1250/);
    // Le contrôle des données sensibles voit les cellules : un IBAN est repéré.
    assert.ok(detectSensitive(file.text).length > 0);
    // Une archive quelconque renommée en .xlsx n'est pas un classeur.
    assert.equal(await prepareSkillFile(Buffer.from(zipSync({ "a.txt": strToU8("x") })), "faux.xlsx"), "unsupported");
  });

  it("image : modèle pour les scripts seulement ; trop lourde, refusée", async () => {
    const file = await prepareSkillFile(png(), "logo.png");
    assert.ok(typeof file !== "string");
    assert.equal(file.mediaType, "image/png");
    assert.ok(file.original);
    assert.match(file.text, /Image « logo\.png »/);
    assert.equal(await prepareSkillFile(png(SKILL_ORIGINAL_MAX_BYTES + 1), "grand.png"), "unsupported");
  });

  it("texte simple : contenu seul, pas d'original (il suffit)", async () => {
    assert.deepEqual(await prepareSkillFile(Buffer.from("# Plan"), "plan.md"), { mediaType: "text/markdown", text: "# Plan" });
  });
});

describe("Script de compétence : fichiers transmis au bac à sable", () => {
  async function setup(inputs: Record<string, Buffer>) {
    const ids: string[] = [];
    const store = new MemorySkillStore(() => null, async () => ids);
    const skill = await store.create(tenant, { name: "Quittances", description: "Faire les quittances", instructions: "Lance fill.py.", confidential: false });
    ids.push(skill.id);
    const script = await store.addFile(tenant, skill.id, { name: "fill.py", mediaType: SKILL_SCRIPT_TYPE, size: 8, text: "print(1)" });
    const runs: SkillRun[] = [];
    const sandbox: CodeSandbox = {
      run: async (_code, options) => {
        runs.push(options.skill!);
        return { exitCode: 0, timedOut: false, durationMs: 1, stdout: "ok", stderr: "", files: [] };
      },
    };
    const asked: string[][] = [];
    const tools = skillTools({
      store,
      tenant,
      agentId: "agent",
      catalog: [{ id: skill.id, name: skill.name, description: skill.description, confidential: false }],
      scripts: {
        sandbox,
        saveFile: async () => assert.fail("aucun fichier produit"),
        runs: { count: 0 },
        inputs: async (names) => (asked.push(names), names.flatMap((name) => (inputs[name] ? [{ name, bytes: inputs[name]! }] : []))),
      },
    });
    const call = (files: unknown) => runTool(tools, { name: "run_skill_script", arguments: { skill: skill.id, script: script!.id, files } }, AbortSignal.timeout(5_000));
    // Appel libre : le modèle désigne le script comme il veut (identifiant, nom, ou rien).
    const raw = (args: Record<string, unknown>) => runTool(tools, { name: "run_skill_script", arguments: { skill: skill.id, ...args } }, AbortSignal.timeout(5_000));
    return { call, raw, runs, asked };
  }

  it("pièces jointes copiées sous inputs/ (noms rendus sûrs) ; jamais sous skill/ ni à la racine", async () => {
    const { call, runs } = await setup({ "Loyers 2026.xlsx": Buffer.from("A"), "a/../../evil.py": Buffer.from("B") });
    const result = await call(["Loyers 2026.xlsx", "a/../../evil.py"]);
    assert.equal(result.isError, false);
    assert.deepEqual(
      runs[0]!.files.map((file) => file.path),
      ["skill/fill.py", "inputs/Loyers_2026.xlsx", "inputs/a_.._.._evil.py"],
    );
    assert.equal(runs[0]!.entry, "skill/fill.py");
    assert.match(result.content, /Pièces jointes copiées : inputs\/Loyers_2026\.xlsx, inputs\/a_\.\._\.\._evil\.py\./);
  });

  it("deux noms qui donnent le même chemin : le second n'écrase pas le premier ; plus de 5 fichiers refusés", async () => {
    const { call, runs } = await setup({ "a b.csv": Buffer.from("1"), "a_b.csv": Buffer.from("2") });
    const result = await call(["a b.csv", "a_b.csv"]);
    assert.deepEqual(runs[0]!.files.filter((file) => file.path.startsWith("inputs/")).map((file) => ("data" in file ? Buffer.from(file.data, "base64").toString() : "")), ["1"]);
    assert.match(result.content, /introuvables dans la conversation \(ou trop lourdes\) : a_b\.csv/);
    const tooMany = await call(["1", "2", "3", "4", "5", "6"]);
    assert.equal(tooMany.isError, true);
    assert.equal(runs.length, 1);
  });

  it("script désigné par son nom, ou pas du tout s'il n'y en a qu'un ; sinon une erreur qui liste les scripts", async () => {
    const { raw, runs } = await setup({});
    assert.equal((await raw({ script: "fill.py" })).isError, false);
    assert.equal((await raw({})).isError, false);
    assert.equal(runs.length, 2);
    const unknown = await raw({ script: "autre.py" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content, /fill\.py/);
    assert.equal(runs.length, 2);
  });
});

