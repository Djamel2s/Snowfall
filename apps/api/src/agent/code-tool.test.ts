import assert from "node:assert/strict";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MemoryGeneratedFileStore } from "../files/generated.js";
import { codeTool, generatedFileIds, MAX_RUNS, UnixSocketSandbox, type CodeSandbox, type SandboxResult, type SkillRun } from "./code-tool.js";
import { runTool } from "./tools.js";

const tenant = { organizationId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const conversation = "33333333-3333-4333-8333-333333333333";
const signal = new AbortController().signal;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function setup(result: Partial<SandboxResult>, scanner?: { scan: (bytes: Buffer) => Promise<{ clean: true } | { clean: false; signature: string }> }) {
  const codes: string[] = [];
  const sandbox: CodeSandbox = {
    run: async (code) => {
      codes.push(code);
      return { exitCode: 0, timedOut: false, durationMs: 420, stdout: "", stderr: "", files: [], ...result };
    },
  };
  const files = new MemoryGeneratedFileStore();
  const runs = { count: 0 };
  const tool = codeTool({ sandbox, scanner, runs, saveFile: (file) => files.create(tenant, conversation, file) });
  return { run: (code: string) => runTool([tool], { id: "c", name: "run_code", arguments: { code } }, signal), codes, files, runs };
}

describe("Interpréteur de code", () => {
  it("sortie rendue au modèle, fichiers enregistrés et rattachables à la réponse", async () => {
    const { run, files } = setup({
      stdout: "320.67\n",
      files: [
        { name: "loyer.png", mediaType: "image/png", size: png.length, data: png.toString("base64") },
        { name: "../../etc/passwd.csv", mediaType: "text/csv", size: 3, data: Buffer.from("a,b").toString("base64") },
      ],
    });
    const result = await run("print(1)");
    assert.match(result.content, /Exécution terminé en 0\.4 s\.[\s\S]*Sortie :\n320\.67/);
    assert.match(result.content, /Fichiers donnés à l'utilisateur[^\n]*loyer\.png/);
    const ids = generatedFileIds([{ role: "tool", name: "run_code", data: result.data }]);
    assert.equal(ids.length, 2);
    // Aucun chemin dans un nom de fichier.
    const stored = await Promise.all(ids.map((id) => files.content(tenant, conversation, id)));
    assert.deepEqual(stored.map((file) => file?.name), ["loyer.png", "_.._etc_passwd.csv"]);
    // Pas encore rattachés : invisibles dans la conversation.
    assert.deepEqual(await files.list(tenant, conversation), []);
    await files.attach(tenant, conversation, "44444444-4444-4444-8444-444444444444", ids);
    assert.equal((await files.list(tenant, conversation)).length, 2);
  });

  it("refuse un type non autorisé et un fichier signalé par l'antivirus", async () => {
    const { run } = setup(
      {
        files: [
          { name: "outil.exe", mediaType: "application/x-msdownload", size: 2, data: "TVo=" },
          { name: "piege.csv", mediaType: "text/csv", size: 5, data: Buffer.from("EICAR").toString("base64") },
          { name: "ok.txt", mediaType: "text/plain", size: 2, data: Buffer.from("ok").toString("base64") },
        ],
      },
      { scan: async (bytes) => (bytes.toString().includes("EICAR") ? { clean: false, signature: "Eicar" } : { clean: true }) },
    );
    const result = await run("x");
    assert.match(result.content, /Fichiers refusés[^\n]*outil\.exe, piege\.csv/);
    assert.deepEqual((result.data as { files: string[] }).files.length, 1);
  });

  it("erreur et délai dépassé : signalés au modèle, qui peut corriger", async () => {
    assert.match((await setup({ exitCode: 1, stderr: "NameError: name 'df' is not defined" }).run("df")).content, /erreur \(code 1\)[\s\S]*NameError/);
    assert.match((await setup({ exitCode: -9, timedOut: true }).run("while True: pass")).content, /délai dépassé/);
  });

  it("nombre d'exécutions borné par réponse", async () => {
    const { run, codes } = setup({ stdout: "ok" });
    for (let index = 0; index <= MAX_RUNS; index++) await run(`print(${index})`);
    assert.equal(codes.length, MAX_RUNS);
  });

  it("pièces jointes : copiées sous inputs/ (cette conversation seulement), le code sous skill/ ; sans fichier, rien ne change", async () => {
    const runs: { code: string; skill: SkillRun | undefined }[] = [];
    const sandbox: CodeSandbox = {
      run: async (code, options) => (runs.push({ code, skill: options.skill }), { exitCode: 0, timedOut: false, durationMs: 1, stdout: "3", stderr: "", files: [] }),
    };
    const asked: string[][] = [];
    const known: Record<string, Buffer> = { "ventes.csv": Buffer.from("mois,ca\n1,10"), "a/../../main.py": Buffer.from("import os") };
    const tool = codeTool({
      sandbox,
      runs: { count: 0 },
      saveFile: async () => assert.fail("aucun fichier produit"),
      inputs: async (names) => (asked.push(names), names.flatMap((name) => (known[name] ? [{ name, bytes: known[name]! }] : []))),
    });
    const call = (args: Record<string, unknown>) => runTool([tool], { id: "c", name: "run_code", arguments: args }, signal);

    const plain = await call({ code: "print(1)" });
    assert.equal(plain.isError, false);
    assert.deepEqual(runs[0], { code: "print(1)", skill: undefined });
    assert.equal(asked.length, 0);

    const result = await call({ code: "import pandas", files: ["ventes.csv", "a/../../main.py", "absent.xlsx"] });
    const skill = runs[1]!.skill!;
    assert.equal(skill.entry, "skill/main.py");
    // Un fichier de l'utilisateur ne remplace jamais le code lancé : il reste sous inputs/.
    assert.deepEqual(skill.files.map((file) => file.path), ["skill/main.py", "inputs/ventes.csv", "inputs/a_.._.._main.py"]);
    assert.deepEqual(skill.files[0], { path: "skill/main.py", content: "import pandas" });
    assert.match(result.content, /Pièces jointes copiées : inputs\/ventes\.csv/);
    assert.match(result.content, /introuvables[^\n]*absent\.xlsx/);
    // Fichiers lus : la réponse sera traitée comme exposée (règle de deux).
    assert.equal((result.data as { inputs: number }).inputs, 2);
    assert.equal((plain.data as { inputs?: number }).inputs, undefined);
    // Plus de 5 fichiers : refusé avant toute exécution.
    assert.equal((await call({ code: "x", files: ["1", "2", "3", "4", "5", "6"] })).isError, true);
    assert.equal(runs.length, 2);
  });

  it("client du bac à sable : HTTP sur socket local, aucun port réseau", async (t) => {
    const path = process.platform === "win32" ? `\\\\.\\pipe\\snowfall-sandbox-${process.pid}` : join(tmpdir(), `snowfall-sandbox-${process.pid}.sock`);
    const received: unknown[] = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ method: request.method, url: request.url, body: JSON.parse(body) });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ exitCode: 0, timedOut: false, durationMs: 5, stdout: "42\n", stderr: "", files: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    t.after(() => server.close());
    const result = await new UnixSocketSandbox(path).run("print(42)", { timeoutSeconds: 30, signal });
    assert.equal(result.stdout, "42\n");
    assert.deepEqual(received, [{ method: "POST", url: "/run", body: { code: "print(42)", timeoutSeconds: 30 } }]);
  });
});
