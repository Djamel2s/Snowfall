import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SENSITIVE_DESIGN, SENSITIVE_HELD_OUT } from "./sensitive-cases.js";
import { detectSensitive, redactSensitive } from "./sensitive.js";
import { memoryRejection } from "../memory/store.js";

describe("Données sensibles : détection locale", () => {
  it("jeu de mise au point : tout juste (il a servi à écrire les règles)", () => {
    for (const item of SENSITIVE_DESIGN) assert.deepEqual(detectSensitive(item.text).sort(), [...item.expected].sort(), item.text);
  });

  it("jeu tenu à l'écart : mesure (écrite après les règles, jamais pour les régler)", () => {
    let caught = 0;
    let missed = 0;
    let falseAlarms = 0;
    for (const item of SENSITIVE_HELD_OUT) {
      const found = detectSensitive(item.text);
      if (item.expected.length) found.some((category) => item.expected.includes(category)) ? caught++ : missed++;
      else if (found.length) falseAlarms++;
    }
    const positives = SENSITIVE_HELD_OUT.filter((item) => item.expected.length).length;
    const negatives = SENSITIVE_HELD_OUT.length - positives;
    console.log(`Données sensibles (tenu à l'écart) : ${caught}/${positives} repérées, ${falseAlarms}/${negatives} fausses alertes`);
    // Seuils planchers : une régression des règles fait échouer le test.
    assert.ok(caught >= positives - 1, `${missed} manquées`);
    assert.ok(falseAlarms <= 1, `${falseAlarms} fausses alertes`);
  });

  it("identifiants : une seule erreur de chiffre et la clé ne correspond plus", () => {
    assert.deepEqual(detectSensitive("1 85 05 78 006 084 91"), ["nir"]);
    assert.deepEqual(detectSensitive("1 85 05 78 006 085 91"), []);
    // Séparateurs usuels : espaces, points, tirets.
    assert.deepEqual(detectSensitive("1-85-05-78-006-084-91"), ["nir"]);
    assert.deepEqual(detectSensitive("1.85.05.78.006.084.91"), ["nir"]);
    assert.deepEqual(detectSensitive("FR76 3000 6000 0112 3456 7890 188"), []);
    assert.deepEqual(detectSensitive("4111 1111 1111 1111"), ["card"]);
  });

  it("texte démesuré : borné, et sans retour arrière catastrophique", () => {
    const started = performance.now();
    detectSensitive(`${"1 ".repeat(100_000)}${"a".repeat(100_000)}`);
    assert.ok(performance.now() - started < 1_000);
  });

  it("titre : identifiants valides masqués, positions justes même avec plusieurs IBAN", () => {
    assert.equal(redactSensitive("Sécu 1 85 05 78 006 084 91, adresse"), "Sécu •••, adresse");
    assert.equal(redactSensitive("de FR76 3000 6000 0112 3456 7890 189 vers DE89 3704 0044 0532 0130 00 svp"), "de ••• vers ••• svp");
    assert.equal(redactSensitive("Carte 4111 1111 1111 1111 ok"), "Carte ••• ok");
    // Ni identifiant valide ni santé : rien ne change.
    assert.equal(redactSensitive("Commande 4111 1111 1111 1112"), "Commande 4111 1111 1111 1112");
  });

  it("mémoire : une donnée sensible n'est jamais retenue", () => {
    assert.equal(memoryRejection("Il est diabétique et suit un traitement lourd."), "sensitive");
    assert.equal(memoryRejection("Préfère des réponses courtes."), null);
  });
});
