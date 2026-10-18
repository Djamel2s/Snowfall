// Mesure du détecteur d'injections sur le jeu tenu à l'écart (gratuit, local).
//   npx tsx scripts/injection-holdout.ts
import { detectInjection } from "../src/security/injection.js";
import { HOLDOUT_ATTACKS, HOLDOUT_BENIGN, HOLDOUT_V2_ATTACKS, HOLDOUT_V2_BENIGN } from "../src/security/injection-holdout.js";

function measure(label: string, attackTexts: string[], benignTexts: string[]) {
  const attacks = attackTexts.map((text) => ({ text, verdict: detectInjection(text) }));
  const benign = benignTexts.map((text) => ({ text, verdict: detectInjection(text) }));
  const caught = attacks.filter((item) => item.verdict.suspicious);
  const flagged = benign.filter((item) => item.verdict.suspicious);
  console.log(`\n${label}`);
  console.log(`  Rappel : ${caught.length}/${attacks.length} attaques signalées`);
  for (const item of attacks.filter((entry) => !entry.verdict.suspicious)) {
    console.log(`    manquée (score ${item.verdict.score}${item.verdict.signals.length ? ` : ${item.verdict.signals.join(", ")}` : ""}) — ${item.text.slice(0, 100)}`);
  }
  console.log(`  Faux positifs : ${flagged.length}/${benign.length} textes légitimes signalés`);
  for (const item of flagged) console.log(`    signalé (${item.verdict.signals.join(", ")}) — ${item.text.slice(0, 100)}`);
}

measure("v1 (jeu de réglage, non-régression)", HOLDOUT_ATTACKS, HOLDOUT_BENIGN);
measure("v2 (tenu à l'écart)", HOLDOUT_V2_ATTACKS, HOLDOUT_V2_BENIGN);
