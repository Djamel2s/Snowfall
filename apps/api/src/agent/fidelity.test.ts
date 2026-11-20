import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { knownNumbers, numbersIn, officeText, unsupportedNumbers } from "./fidelity.js";

// Documents réels produits par Gemini Flash-Lite dans le bac à sable (17 novembre),
// à partir des demandes ci-dessous.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../files/fixtures/${name}`, import.meta.url)));
const REPORT =
  "Rédige un rapport Word de deux pages sur les incidents informatiques du trimestre : 42 incidents (31 mineurs, 9 majeurs, 2 critiques), " +
  "délai moyen de résolution 6 h, principale cause : mots de passe réinitialisés.";
const DECK =
  "Prépare une présentation PowerPoint de 6 à 8 diapositives : bilan 2026 de Polaris. Chiffre d'affaires 4,2 M€ (+18 %), marge 22 %, " +
  "3 nouveaux clients grands comptes ; ventes trimestrielles 0,9 / 1,0 / 1,1 / 1,2 M€ ; recrutement de 12 personnes.";
const BUDGET = "Budget 2027 par service : Ventes 820 k€, Marketing 310 k€, R&D 1 150 k€, Support 240 k€, Administration 180 k€.";

describe("Contrôle de fidélité des documents produits", () => {
  it("lit les nombres en français et en anglais ; ignore dates, heures, numérotation, années", () => {
    assert.deepEqual(
      numbersIn("CA de 1 150 k€, 4,2 M€, 0.9, 73,8 %, −12 au 17/11/2026 à 14:30 en 2026 ; T1 et MP3").map((item) => [item.text, item.value, item.percent]),
      [["1 150", 1150, false], ["4,2", 4.2, false], ["0.9", 0.9, false], ["73,8 %", 73.8, true], ["−12", -12, false], ["2026", 2026, false]],
    );
    assert.deepEqual(numbersIn("1. Synthèse\n2.1 Détail\n3) Agir\n7").map((item) => item.value), []);
    // « 12 h » en tête de ligne reste une donnée (pas une numérotation).
    assert.deepEqual(numbersIn("12 h\n24 h").map((item) => item.value), [12, 24]);
  });

  it("rapport réel : les délais par gravité inventés sont signalés, pas les chiffres donnés ni leurs parts", () => {
    const flagged = unsupportedNumbers(officeText(fixture("rapport-invente.docx")), knownNumbers(REPORT));
    assert.deepEqual(flagged, ["4", "12", "24"]);
  });

  it("présentation et classeur réels, fidèles : rien n'est signalé (total, parts en fraction, M€, numéros de diapositive)", () => {
    assert.deepEqual(unsupportedNumbers(officeText(fixture("bilan-fidele.pptx")), knownNumbers(DECK)), []);
    assert.deepEqual(unsupportedNumbers(officeText(fixture("budget-fidele.xlsx")), knownNumbers(BUDGET)), []);
  });

  it("déductions admises : total, moyenne, écart, part et évolution en %, changement d'unité ; le reste est signalé", () => {
    const known = knownNumbers(BUDGET);
    assert.deepEqual(unsupportedNumbers("Total 2 700 k€, soit 2,7 M€ ; moyenne 540 k€ ; R&D 42,6 % ; écart 840 k€ ; 0,3037", known), []);
    assert.deepEqual(unsupportedNumbers("Ventes +12,5 % ; 37 % du budget ; 95 k€ de frais", known), ["+12,5 %", "37 %", "95"]);
    // Petit nombre : une somme de deux nombres connus l'explique (9 + 2 majeurs et critiques), pas un écart ni une moyenne.
    const incidents = knownNumbers("42 incidents (31 mineurs, 9 majeurs, 2 critiques), délai moyen 6 h");
    assert.deepEqual(unsupportedNumbers("Les 11 incidents majeurs et critiques", incidents), []);
    assert.deepEqual(unsupportedNumbers("Délai cible : 4 h ; 7 sites", incidents), ["4", "7"]);
  });

  it("Excel : une cellule calculée par une formule est une déduction, pas une donnée lue", () => {
    const text = officeText(fixture("budget-fidele.xlsx"));
    assert.ok(text.includes("820") && text.includes("1150"));
  });
});
