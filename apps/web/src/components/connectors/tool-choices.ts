import type { McpDiscoveredTool } from '../../lib/api'

export type ToolChoice = { selected: boolean; access: 'read' | 'write' }
export type ToolChoices = Record<string, ToolChoice>
export type ToolMode = 'read' | 'all' | 'custom'

/** Choix d'un mode : lecture seule (outils annoncés en lecture), tout, ou outil par outil. */
export function presetChoices(tools: McpDiscoveredTool[], mode: Exclude<ToolMode, 'custom'>): ToolChoices {
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      { selected: tool.supported && (mode === 'all' || tool.readOnlyHint), access: tool.readOnlyHint ? 'read' : 'write' } satisfies ToolChoice,
    ]),
  )
}

/** Mode de départ : celui qui correspond aux choix déjà faits, sinon lecture seule. */
export function initialMode(tools: McpDiscoveredTool[], approved: { name: string; access: 'read' | 'write' }[]): ToolMode {
  if (approved.length) return 'custom'
  return tools.some((tool) => tool.supported && tool.readOnlyHint) ? 'read' : 'custom'
}
