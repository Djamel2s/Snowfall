import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IMPORT_MAX_CONVERSATIONS, parseImport } from "./import.js";

describe("Import de conversations", () => {
  it("ChatGPT : branche affichée seulement, texte seulement", () => {
    const exported = [
      {
        title: "Plan de vacances",
        current_node: "a2",
        mapping: {
          root: { id: "root", message: null, parent: null },
          sys: { message: { author: { role: "system" }, content: { content_type: "text", parts: ["Consignes cachées"] } }, parent: "root" },
          u1: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["Où partir en mai ?"] } }, parent: "sys" },
          a1: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Ancienne réponse"] } }, parent: "u1" },
          a2: { message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["En Grèce."] } }, parent: "u1" },
          code: { message: { author: { role: "tool" }, content: { content_type: "code", text: "rm -rf /" } }, parent: "u1" },
        },
      },
    ];
    const parsed = parseImport(exported)!;
    assert.equal(parsed.format, "chatgpt");
    assert.deepEqual(parsed.conversations, [{ title: "Plan de vacances", messages: [{ role: "user", content: "Où partir en mai ?" }, { role: "assistant", content: "En Grèce." }] }]);
  });

  it("LibreChat et Snowfall ; conversations vides écartées", () => {
    const libre = parseImport({ title: "Code", messages: [{ isCreatedByUser: true, text: "Bonjour" }, { isCreatedByUser: false, text: "Salut !" }] })!;
    assert.equal(libre.format, "librechat");
    assert.deepEqual(libre.conversations[0]!.messages.map((message) => message.role), ["user", "assistant"]);

    const own = parseImport({ format: "snowfall.conversation", version: 1, title: "", messages: [{ role: "user", content: "Question sans titre" }, { role: "system", content: "x" }] })!;
    assert.deepEqual(own.conversations, [{ title: "Question sans titre", messages: [{ role: "user", content: "Question sans titre" }] }]);

    const empty = parseImport([{ title: "Vide", current_node: "x", mapping: {} }])!;
    assert.deepEqual([empty.conversations.length, empty.skipped], [0, 1]);
  });

  it("format inconnu refusé ; volumes bornés ; boucle dans l'arbre sans effet", () => {
    assert.equal(parseImport({ hello: "world" }), null);
    assert.equal(parseImport("texte"), null);
    const many = Array.from({ length: IMPORT_MAX_CONVERSATIONS + 10 }, (_, index) => ({ title: `C${index}`, messages: [{ isCreatedByUser: true, text: "x" }] }));
    assert.equal(parseImport(many)!.conversations.length, IMPORT_MAX_CONVERSATIONS);
    const loop = parseImport([{ title: "Boucle", current_node: "a", mapping: { a: { parent: "b", message: { author: { role: "user" }, content: { content_type: "text", parts: ["A"] } } }, b: { parent: "a", message: null } } }])!;
    assert.deepEqual(loop.conversations[0]!.messages, [{ role: "user", content: "A" }]);
  });
});
