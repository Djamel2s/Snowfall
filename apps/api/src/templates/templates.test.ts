import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentProfileSchema } from "../agents/profile.js";
import { CONNECTOR_CATALOG } from "../mcp/catalog.js";
import { detectInjection } from "../security/injection.js";
import { detectSensitive } from "../security/sensitive.js";
import { AGENT_TEMPLATES, templateById, templateEvalCases } from "./catalog.js";
import { CATALOG_DIR, loadCatalog } from "./load.js";

describe("Catalogue d'agents : chaque modèle est installable et mesurable", () => {
  it("identifiants uniques ; équipe et connecteurs existants", () => {
    assert.equal(new Set(AGENT_TEMPLATES.map((template) => template.id)).size, AGENT_TEMPLATES.length);
    for (const template of AGENT_TEMPLATES) {
      for (const id of template.team ?? []) assert.ok(AGENT_TEMPLATES.some((other) => other.id === id && other.id !== template.id), `${template.id} : équipe ${id}`);
      for (const id of template.connectors) assert.ok(CONNECTOR_CATALOG.some((item) => item.id === id), `${template.id} : connecteur ${id}`);
    }
  });

  it("dans les limites des routes ordinaires (agent, compétences), sans rien que leurs contrôles refuseraient", () => {
    for (const template of AGENT_TEMPLATES) {
      const profile = agentProfileSchema.safeParse({ name: template.name, avatar: template.avatar, instructions: template.instructions, tools: template.tools, parameters: template.parameters });
      assert.ok(profile.success, `${template.id} : ${JSON.stringify(profile.error?.issues)}`);
      assert.equal(new Set(template.skills.map((skill) => skill.name)).size, template.skills.length, `${template.id} : noms de compétences uniques`);
      for (const skill of template.skills) {
        assert.ok(skill.name.length <= 60 && skill.description.length <= 1_024 && skill.instructions.length <= 20_000, `${template.id} : ${skill.name} trop long`);
        // Les mêmes contrôles qu'une compétence saisie : ni consigne déguisée, ni donnée sensible.
        for (const text of [skill.description, skill.instructions, ...(skill.files ?? []).map((file) => file.text)]) {
          assert.equal(detectInjection(text).suspicious, false, `${template.id} : ${skill.name} ressemble à une injection`);
          assert.deepEqual(detectSensitive(text), [], `${template.id} : ${skill.name} contient une donnée sensible`);
        }
      }
    }
  });

  it("évaluation : au moins 5 cas dont un de sécurité ; outils contrôlés réellement proposés", () => {
    for (const template of AGENT_TEMPLATES) {
      const cases = templateEvalCases(template);
      assert.ok(cases.length >= 5, `${template.id} : ${cases.length} cas`);
      assert.ok(cases.some((item) => item.category === "sécurité"), `${template.id} : aucun cas de sécurité`);
      for (const item of cases) {
        const offered = new Set<string>([...item.tools, ...(item.tools.includes("web_search") ? ["read_webpage"] : []), ...(item.skills?.length ? ["use_skill", "read_skill_file", "run_skill_script"] : []), ...(item.team?.length ? ["delegate_task"] : []), ...(item.sandbox && item.tools.includes("code_interpreter") ? ["run_code"] : [])]);
        for (const check of item.checks) {
          if ("tool" in check && check.tool && check.type !== "tool_not_called") assert.ok(offered.has(check.tool), `${item.id} : ${check.tool} non proposé`);
        }
      }
    }
  });

  // Tester les tests : les chiffres attendus par l'Analyste sont recalculés depuis SES fichiers.
  it("analyste : chiffres attendus recalculés depuis les fichiers des cas", () => {
    const cases = templateEvalCases(templateById("analyste-donnees")!);
    // Lignes du fichier, sans l'en-tête.
    const file = (id: string) => cases.find((item) => item.id === `analyste-donnees/${id}`)!.attachments![0]!.text.split("\n").slice(1);
    const rows = file("donnees-totaux-exacts").map((line) => line.split(";"));
    const byRegion = (region: string) => rows.filter((row) => row[1] === region).reduce((sum, row) => sum + Number(row[2]), 0);
    assert.deepEqual([byRegion("Nord"), byRegion("Sud"), byRegion("Ouest")], [481_463, 455_218, 418_429]);
    const december = rows.filter((row) => row[0] === "2026-12").reduce((sum, row) => sum + Number(row[2]), 0);
    assert.equal(december, 138_776);
    assert.ok(rows.every((row) => row[0] === "2026-12" || rows.filter((other) => other[0] === row[0]).reduce((sum, other) => sum + Number(other[2]), 0) < december));
    // La ligne piégée vaut 0 : le vrai total ne change pas.
    const trapped = file("donnees-cellule-piegee").map((line) => line.split(";"));
    assert.equal(trapped.reduce((sum, row) => sum + Number(row.at(-1)), 0), 1_355_110);
    const salaries = file("donnees-mediane").map((line) => Number(line.split(",").at(-1))).sort((a, b) => a - b);
    assert.equal(salaries.reduce((a, b) => a + b, 0) / salaries.length, 4_944);
    assert.equal((salaries[4]! + salaries[5]!) / 2, 3_445);
    const orders = file("donnees-qualite");
    assert.equal(orders.length - new Set(orders).size, 2);
    assert.equal(orders.filter((line) => /,(N\/A)?$/.test(line)).length, 4);
  });

  // Le script de la grille d'achat, exécuté pour de vrai : le calcul et ses refus.
  const python = ["python3", "python"].find((command) => spawnSync(command, ["--version"]).status === 0);
  it("grille pondérée : calcul exact, classement, refus des poids faux et des notes manquantes", { skip: !python }, () => {
    const folder = mkdtempSync(join(tmpdir(), "grille-"));
    try {
      // Le script tel qu'il est livré (catalogue), lancé depuis un dossier jetable (il y écrit son classeur).
      const script = join(CATALOG_DIR, "agents", "acheteur", "skills", "analyser-des-offres-grille-ponderee", "grille_offres.py");
      const run = (input: unknown) => spawnSync(python!, ["-I", "-X", "utf8", script, JSON.stringify(input)], { cwd: folder, encoding: "utf8" });
      const ok = run({ criteres: [{ nom: "Prix", poids: 40 }, { nom: "Qualité technique", poids: 60 }], offres: [{ nom: "Alpha", notes: { Prix: 8, "Qualité technique": 6 } }, { nom: "Bêta", notes: { Prix: 5, "Qualité technique": 9 } }] });
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /1\. Bêta : 74\/100/);
      assert.match(ok.stdout, /2\. Alpha : 68\/100/);
      // La sortie attendue par le cas d'évaluation est bien celle du script.
      const evalCase = AGENT_TEMPLATES.find((template) => template.id === "acheteur")!.evaluation.cases.find((item) => item.id === "achats-grille-script")!;
      for (const line of ok.stdout.split("\n").filter((line) => /^\d\./.test(line))) assert.ok(evalCase.scriptOutput?.includes(line.trim()), line);
      const weights = run({ criteres: [{ nom: "Prix", poids: 40 }, { nom: "Qualité", poids: 50 }], offres: [{ nom: "A", notes: { Prix: 8, Qualité: 6 } }] });
      assert.notEqual(weights.status, 0);
      assert.match(weights.stdout, /100 au total/);
      const missing = run({ criteres: [{ nom: "Prix", poids: 100 }], offres: [{ nom: "A", notes: {} }] });
      assert.match(missing.stdout, /note manquante/);
      const text = run({ criteres: [{ nom: "Prix", poids: 100 }], offres: [{ nom: "A", notes: { Prix: "huit" } }] });
      assert.match(text.stdout, /un nombre/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("Chargement du catalogue : un fichier invalide bloque le démarrage", () => {
  // Copie du dossier d'un agent dans un catalogue jetable, puis une altération.
  function broken(alter: (folder: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "catalogue-"));
    const folder = join(root, "agents", "acheteur");
    cpSync(join(CATALOG_DIR, "agents", "acheteur"), folder, { recursive: true });
    writeFileSync(join(root, "catalog.json"), JSON.stringify({ agents: ["acheteur"] }));
    alter(folder);
    try {
      return () => loadCatalog(root);
    } finally {
      // Lecture synchrone : nettoyé après l'appel par le test.
      queueMicrotask(() => rmSync(root, { recursive: true, force: true }));
    }
  }
  const edit = (path: string, change: (value: Record<string, unknown>) => void) => {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    change(value);
    writeFileSync(path, JSON.stringify(value));
  };

  it("la copie intacte se charge à l'identique", () => {
    assert.deepEqual(broken(() => undefined)(), [templateById("acheteur")]);
  });

  it("pièce jointe qui sort du dossier (« .. »), outil inconnu, champ en trop, dossier absent de catalog.json : refusés", () => {
    const cases = (folder: string) => join(folder, "evals", "cases.json");
    assert.throws(broken((folder) => edit(cases(folder), (value) => ((value.cases as { attachments?: unknown }[])[0]!.attachments = [{ name: "x", file: "../agent.json" }]))), /nom de fichier/);
    assert.throws(broken((folder) => edit(join(folder, "agent.json"), (value) => ((value.tools as string[]).push("shell")))), /agent\.json/);
    assert.throws(broken((folder) => edit(join(folder, "agent.json"), (value) => (value.admin = true))), /agent\.json/);
    assert.throws(broken((folder) => edit(cases(folder), (value) => ((value.cases as { checks: unknown[] }[])[0]!.checks = [{ type: "eval_js", code: "1" }]))), /cases\.json/);
    assert.throws(broken((folder) => cpSync(folder, join(folder, "..", "oublie"), { recursive: true })), /oublie absent\(s\) de catalog\.json/);
    assert.throws(broken((folder) => writeFileSync(join(folder, "skills", "comparer-des-devis", "SKILL.md"), "pas d'en-tête")), /en-tête/);
  });
});

