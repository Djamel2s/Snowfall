import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ENCRYPTED_TABLES } from "./rotation.js";

describe("Rotation des clés : inventaire des colonnes chiffrées", () => {
  /** Colonnes que la base OBLIGE à être chiffrées (contraintes « <version>:v1… »). */
  function enforcedColumns() {
    const root = fileURLToPath(new URL("../../drizzle/", import.meta.url));
    const found = new Set<string>();
    for (const folder of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const sql = readFileSync(`${root}${folder.name}/migration.sql`, "utf8");
      for (const statement of sql.split("--> statement-breakpoint")) {
        const table = /ALTER TABLE "([a-z_]+)" ADD CONSTRAINT/.exec(statement)?.[1];
        if (!table) continue;
        for (const match of statement.matchAll(/"([a-z_]+)" ~ '\^\[0-9\]\+:v1/g)) found.add(`${table}.${match[1]}`);
      }
    }
    return found;
  }

  const inventory = new Set(ENCRYPTED_TABLES.flatMap((target) => target.fields.map((field) => `${target.table}.${field.column}`)));

  it("toute colonne chiffrée en base est rechiffrée par la rotation (aucun oubli possible)", () => {
    const missing = [...enforcedColumns()].filter((column) => !inventory.has(column));
    assert.deepEqual(missing, [], "Colonne chiffrée absente de src/crypto/rotation.ts");
  });

  it("l'inventaire ne déclare rien que la base ne protège pas", () => {
    const enforced = enforcedColumns();
    const extra = [...inventory].filter((column) => !enforced.has(column));
    assert.deepEqual(extra, []);
  });
});
