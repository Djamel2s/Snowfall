import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  DecryptionError,
  LocalKeyEncryptionProvider,
  deriveKey,
  open,
  parseMasterKey,
  seal,
} from "./envelope.js";

describe("chiffrement AES-256-GCM", () => {
  const key = randomBytes(32);

  it("déchiffre ce qu'il a chiffré", () => {
    const sealed = seal(key, "données sensibles", "ctx");
    assert.equal(open(key, sealed, "ctx").toString("utf8"), "données sensibles");
    assert.ok(!sealed.includes("sensibles"));
  });

  it("produit un chiffré différent à chaque appel (IV aléatoire)", () => {
    assert.notEqual(seal(key, "x", "ctx"), seal(key, "x", "ctx"));
  });

  it("refuse un chiffré déplacé dans un autre contexte (AAD)", () => {
    const sealed = seal(key, "secret", "message:orgA:alice");
    assert.throws(() => open(key, sealed, "message:orgB:bob"), DecryptionError);
  });

  it("refuse un chiffré altéré", () => {
    const sealed = seal(key, "secret", "ctx");
    const parts = sealed.split(".");
    const payload = Buffer.from(parts[2]!, "base64url");
    payload[0] = payload[0]! ^ 0xff;
    parts[2] = payload.toString("base64url");
    assert.throws(() => open(key, parts.join("."), "ctx"), DecryptionError);
  });

  it("refuse une autre clé", () => {
    assert.throws(() => open(randomBytes(32), seal(key, "x", "ctx"), "ctx"), DecryptionError);
  });

  it("refuse un format inconnu", () => {
    assert.throws(() => open(key, "texte en clair", "ctx"), DecryptionError);
  });
});

describe("clés", () => {
  it("exige une clé maîtresse de 32 octets", () => {
    assert.throws(() => parseMasterKey(randomBytes(16).toString("base64")));
    assert.equal(parseMasterKey(randomBytes(32).toString("base64")).length, 32);
  });

  it("dérive des clés distinctes par usage", () => {
    const master = randomBytes(32);
    assert.notDeepEqual(deriveKey(master, "session/v1"), deriveKey(master, "kek/v1"));
  });

  it("enveloppe une DEK liée à son organisation", async () => {
    const kek = new LocalKeyEncryptionProvider(randomBytes(32));
    const dek = randomBytes(32);
    const wrapped = await kek.wrap(dek, "organization-key:A:1");

    assert.deepEqual(await kek.unwrap(wrapped, "organization-key:A:1"), dek);
    await assert.rejects(kek.unwrap(wrapped, "organization-key:B:1"), DecryptionError);
  });
});
