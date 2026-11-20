import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// La commande « npm test » liste ses fichiers un par un : un test oublié dans la
// liste ne tourne jamais et ne protège rien (sharing.integration.test.ts l'a été).

const root = fileURLToPath(new URL("../..", import.meta.url));

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return testFiles(path);
    return name.endsWith(".test.ts") ? [relative(root, path).split(sep).join("/")] : [];
  });
}

describe("Liste des tests", () => {
  it("chaque fichier *.test.ts de src est lancé par « npm test »", () => {
    const script = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: { test: string } }).scripts.test;
    const listed = new Set(script.split(/\s+/));
    const missing = testFiles(join(root, "src")).filter((file) => !listed.has(file));
    assert.deepEqual(missing, []);
  });
});
