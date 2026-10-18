/**
 * Retire des balises d'un texte non fiable, jusqu'à ce qu'il n'en reste plus.
 *
 * Un seul passage ne suffit pas : « </mcp_<mcp_result>result> » perd sa balise
 * intérieure et devient « </mcp_result> », une vraie balise fermante qui ferait
 * sortir la suite du bloc de données. On recommence donc tant que le texte change.
 */
export function stripTags(text: string, tags: RegExp): string {
  const pattern = new RegExp(tags.source, tags.flags.includes("g") ? tags.flags : `${tags.flags}g`);
  let current = text;
  for (let pass = 0; pass < 100; pass++) {
    const next = current.replace(pattern, "");
    if (next === current) return next;
    current = next;
  }
  // Construction pathologique : on neutralise tous les chevrons plutôt que de laisser passer.
  return current.replace(/[<>]/g, " ");
}

/**
 * Marquage des contenus externes (« datamarking », Microsoft, 2024) : chaque
 * espace devient « ˆ ». Le prompt système dit au modèle que tout texte ainsi
 * marqué est une donnée écrite par un inconnu. Contrairement aux balises, le
 * marquage est partout dans le texte : une consigne glissée au milieu d'une page
 * reste visiblement « de la page ». Les sauts de ligne sont gardés (structure).
 */
export const DATAMARK = "ˆ";

export function datamark(text: string) {
  return text.replace(/[ \t\u00a0\u2009\u202f]+/g, DATAMARK);
}

