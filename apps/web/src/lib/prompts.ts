// Variables d'un prompt : {{nom}}. Remplacées au moment de l'insertion dans la
// zone de saisie (rien n'est envoyé avant que l'utilisateur valide son message).

const VARIABLE = /\{\{\s*([\p{L}\p{N}_ -]{1,40}?)\s*\}\}/gu

/** Variables dans l'ordre d'apparition, sans doublon. */
export function promptVariables(content: string) {
  return [...new Set([...content.matchAll(VARIABLE)].map((match) => match[1]!.trim()))]
}

/** Texte final : chaque {{variable}} remplacée par sa valeur (vide si non renseignée). */
export function fillPrompt(content: string, values: Record<string, string>) {
  return content.replace(VARIABLE, (_match, name: string) => values[name.trim()] ?? '')
}

/** « /mot » en début de saisie : recherche d'un prompt (null sinon). */
export function slashQuery(input: string) {
  return /^\/([^\s/]{0,40})$/.exec(input)?.[1] ?? null
}
