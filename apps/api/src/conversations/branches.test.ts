import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activePath, latestLeaf, type BranchNode } from "./branches.js";

// u1 → a1 → u2 → a2
//            ↘ u2' → a2'   (modification de u2)
//                   ↘ a2'' (régénération de a2')
const nodes: BranchNode[] = [
  { id: "u1", parentId: null, createdAt: "1" },
  { id: "a1", parentId: "u1", createdAt: "2" },
  { id: "u2", parentId: "a1", createdAt: "3" },
  { id: "a2", parentId: "u2", createdAt: "4" },
  { id: "u2'", parentId: "a1", createdAt: "5" },
  { id: "a2'", parentId: "u2'", createdAt: "6" },
  { id: "a2''", parentId: "u2'", createdAt: "7" },
];

describe("Branches de conversation", () => {
  it("chemin de la feuille retenue, avec la position de chaque version", () => {
    const { path, branches } = activePath(nodes, "a2");
    assert.deepEqual(path, ["u1", "a1", "u2", "a2"]);
    assert.deepEqual(branches.get("u2"), { index: 0, count: 2, siblings: ["u2", "u2'"] });
    assert.equal(branches.has("a2"), false);
  });

  it("sans feuille retenue (ou inconnue) : la branche la plus récente", () => {
    assert.deepEqual(activePath(nodes, null).path, ["u1", "a1", "u2'", "a2''"]);
    assert.deepEqual(activePath(nodes, "inconnu").path, ["u1", "a1", "u2'", "a2''"]);
    assert.deepEqual(activePath(nodes, "a2''").branches.get("a2''"), { index: 1, count: 2, siblings: ["a2'", "a2''"] });
  });

  it("choisir une version : on descend vers sa suite la plus récente", () => {
    assert.equal(latestLeaf(nodes, "u2'"), "a2''");
    assert.equal(latestLeaf(nodes, "u2"), "a2");
    assert.equal(latestLeaf([], null), null);
  });

  it("une boucle accidentelle dans les données ne bloque pas", () => {
    const loop: BranchNode[] = [
      { id: "x", parentId: "y", createdAt: "1" },
      { id: "y", parentId: "x", createdAt: "2" },
    ];
    assert.ok(activePath(loop, "x").path.length <= 2);
  });
});
