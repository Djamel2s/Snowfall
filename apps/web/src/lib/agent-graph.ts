import type { Agent, AgentInput, McpServer, ToolId } from './api'

// Graphe de l'organisation : agents et leurs équipes (délégation). Les
// connecteurs et capacités d'un agent sont ses SATELLITES : ils gravitent autour
// de lui, sans trait (seuls les liens entre agents sont dessinés). Logique pure
// (testée à part) ; le rendu et l'animation sont dans components/AgentGraph.tsx.

export type GraphNode = { id: string; kind: 'agent'; label: string; agent: Agent }

/** Connecteur ou capacité d'UN agent (chaque agent a ses propres satellites). */
export type Satellite = { id: string; kind: 'connector' | 'capability'; label: string; tool?: ToolId }

/** team : A confie des tâches à B. */
export type GraphLink = { id: string; source: string; target: string; kind: 'team' }

/** Rayon de l'orbite des satellites autour d'un agent. */
export const ORBIT = 66

/** Position d'un satellite sur l'orbite : répartis à égale distance, tournant avec la phase. */
export function orbit(index: number, count: number, phase = 0, radius = ORBIT) {
  const angle = phase - Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, count)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}

/** Capacités montrées comme nœuds (la base de connaissances est propre à chaque agent). */
const CAPABILITIES: ToolId[] = ['web_search', 'code_interpreter', 'image_generation']

export function buildAgentGraph(agents: Agent[], servers: McpServer[], capabilityLabel: (tool: ToolId) => string) {
  const nodes: GraphNode[] = agents.map((agent) => ({ id: `agent:${agent.id}`, kind: 'agent', label: agent.name, agent }))
  const links: GraphLink[] = []
  const satellites = new Map<string, Satellite[]>()
  const known = new Set(agents.map((agent) => agent.id))
  const serverNames = new Map(servers.map((server) => [server.id, server.name]))
  for (const agent of agents) {
    for (const delegate of agent.delegates ?? []) {
      if (known.has(delegate) && delegate !== agent.id) links.push({ id: `team:${agent.id}:${delegate}`, source: `agent:${agent.id}`, target: `agent:${delegate}`, kind: 'team' })
    }
    const own: Satellite[] = []
    for (const tool of CAPABILITIES) {
      if (agent.tools.includes(tool)) own.push({ id: `capability:${agent.id}:${tool}`, kind: 'capability', label: capabilityLabel(tool), tool })
    }
    // Un connecteur inconnu (supprimé, non visible) n'est pas montré.
    if (agent.tools.includes('mcp')) {
      for (const server of agent.mcpServers ?? []) {
        const name = serverNames.get(server)
        if (name) own.push({ id: `connector:${agent.id}:${server}`, kind: 'connector', label: name })
      }
    }
    if (own.length) satellites.set(`agent:${agent.id}`, own)
  }
  return { nodes, links, satellites }
}

/** Voisins d'un nœud (survol : ils restent allumés, le reste s'estompe). */
export function neighbors(links: GraphLink[], id: string) {
  const found = new Set([id])
  for (const link of links) {
    if (link.source === id) found.add(link.target)
    if (link.target === id) found.add(link.source)
  }
  return found
}

export const MAX_TEAM_SIZE = 5

/** Ajout d'un agent à l'équipe d'un autre : refusé s'il est lui-même, déjà présent, ou si l'équipe est pleine. */
export function canAddToTeam(owner: Agent, member: Agent) {
  const team = owner.delegates ?? []
  return owner.canEdit && owner.id !== member.id && !team.includes(member.id) && team.length < MAX_TEAM_SIZE
}

/** Profil complet d'un agent, pour l'enregistrer après un changement d'équipe. */
export function agentInput(agent: Agent, delegates: string[]): AgentInput {
  return {
    name: agent.name,
    avatar: agent.avatar,
    instructions: agent.instructions,
    provider: agent.provider,
    model: agent.model,
    tools: delegates.length && !agent.tools.includes('delegate') ? [...agent.tools, 'delegate'] : agent.tools,
    mcpServers: agent.mcpServers ?? [],
    parameters: agent.parameters ?? {},
    delegates,
  }
}
