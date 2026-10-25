// Variables d'un prompt : {{nom}}. Remplacées au moment de l'insertion dans la
// zone de saisie (rien n'est envoyé avant que l'utilisateur valide son message).

const VARIABLE = /\{\{\s*([\p{L}\p{N}_ -]{1,40}?)\s*\}\}/gu

/** Variables dans l'ordre d'apparition, sans doublon. */
export function promptVariables(content: string) {
  return [...new Set([...content.matchAll(VARIABLE)].map((match) => match[1]!.trim()))]
}

/** Variables remplies d'office (comme LibreChat) : date, heure, jour, utilisateur. Insensibles à la casse. */
const AUTOMATIC = ['date', 'heure', 'jour', 'utilisateur', 'current_date', 'current_time', 'current_datetime', 'current_user'] as const

export const isAutomatic = (name: string) => (AUTOMATIC as readonly string[]).includes(name.trim().toLowerCase())

/** Variables à demander à l'utilisateur : toutes sauf celles remplies d'office. */
export function askedVariables(content: string) {
  return promptVariables(content).filter((name) => !isAutomatic(name))
}

/** Valeurs des variables automatiques, au moment de l'insertion. */
export function automaticValues({ now, locale, user }: { now: Date; locale: string; user: string }): Record<string, string> {
  const date = now.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })
  const time = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const day = now.toLocaleDateString(locale, { weekday: 'long' })
  return { date, heure: time, jour: day, utilisateur: user, current_date: date, current_time: time, current_datetime: `${date} ${time}`, current_user: user }
}

/**
 * Texte final : chaque {{variable}} remplacée par sa valeur (vide si non
 * renseignée) ; les variables automatiques par la leur.
 */
export function fillPrompt(content: string, values: Record<string, string>, automatic: Record<string, string> = {}) {
  return content.replace(VARIABLE, (_match, name: string) => values[name.trim()] ?? automatic[name.trim().toLowerCase()] ?? '')
}

/** « /mot » en début de saisie : recherche d'un prompt (null sinon). */
export function slashQuery(input: string) {
  return /^\/([^\s/]{0,40})$/.exec(input)?.[1] ?? null
}
