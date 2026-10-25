import type { McpDiscoveredTool } from '../../lib/api'

export type ToolChoice = { selected: boolean; access: 'read' | 'write' }
export type ToolChoices = Record<string, ToolChoice>
export type ToolMode = 'read' | 'all' | 'custom'

// Verbes qui modifient ou envoient : un outil ainsi nommé n'est jamais pris pour
// une lecture, même si l'éditeur l'annonce (readOnlyHint n'est qu'une déclaration).
const WRITE_WORDS = /(^|[^a-z])(create|update|delete|remove|send|post|write|edit|add|set|move|archive|publish|upload|insert|patch|put|merge|close|assign|comment|invite|share|cancel|approve|transfer|pay|book|reply|forward|rename|replace|submit|trigger|run|execute|grant|revoke)/

const words = (tool: McpDiscoveredTool) =>
  `${tool.name} ${tool.title ?? ''}`
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()

/** Annoncé en lecture, mais son nom dit le contraire : à vérifier par l'administrateur. */
export const suspiciousRead = (tool: McpDiscoveredTool) => tool.readOnlyHint && WRITE_WORDS.test(words(tool))

/** Lecture seule crédible : annoncée par l'éditeur ET cohérente avec son nom. */
export const trustedRead = (tool: McpDiscoveredTool) => tool.readOnlyHint && !suspiciousRead(tool)

/** Droit proposé par défaut : lecture seulement si elle est crédible. */
export const defaultAccess = (tool: McpDiscoveredTool): ToolChoice['access'] => (trustedRead(tool) ? 'read' : 'write')

/** Choix d'un mode : lecture seule (outils crédibles en lecture), tout, ou outil par outil. */
export function presetChoices(tools: McpDiscoveredTool[], mode: Exclude<ToolMode, 'custom'>): ToolChoices {
  return Object.fromEntries(
    tools.map((tool) => [tool.name, { selected: tool.supported && (mode === 'all' || trustedRead(tool)), access: defaultAccess(tool) } satisfies ToolChoice]),
  )
}

/** Mode de départ : celui qui correspond aux choix déjà faits, sinon lecture seule. */
export function initialMode(tools: McpDiscoveredTool[], approved: { name: string; access: 'read' | 'write' }[]): ToolMode {
  if (approved.length) return 'custom'
  return tools.some((tool) => tool.supported && trustedRead(tool)) ? 'read' : 'custom'
}
