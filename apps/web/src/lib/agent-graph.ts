import type { Agent, AgentInput, McpServer, ToolId } from './api'

// Graphe de l'organisation : agents, leurs équipes (délégation), leurs
// connecteurs et leurs capacités. Logique pure (testée à part) ; le rendu et
// l'animation sont dans components/AgentGraph.tsx.

export type GraphNode =
  | { id: string; kind: 'agent'; label: string; agent: Agent }
  | { id: string; kind: 'connector'; label: string }
  | { id: string; kind: 'capability'; label: string; tool: ToolId }

/** team : A confie des tâches à B ; uses : A utilise un connecteur ou une capacité. */
export type GraphLink = { id: string; source: string; target: string; kind: 'team' | 'uses' }

/** Capacités montrées comme nœuds (la base de connaissances est propre à chaque agent). */
const CAPABILITIES: ToolId[] = ['web_search', 'code_interpreter', 'image_generation']

export function buildAgentGraph(agents: Agent[], servers: McpServer[], capabilityLabel: (tool: ToolId) => string) {
  const nodes: GraphNode[] = agents.map((agent) => ({ id: `agent:${agent.id}`, kind: 'agent', label: agent.name, agent }))
  const links: GraphLink[] = []
  const known = new Set(agents.map((agent) => agent.id))
  const usedServers = new Set<string>()
  const usedTools = new Set<ToolId>()
  for (const agent of agents) {
    for (const delegate of agent.delegates ?? []) {
      if (known.has(delegate) && delegate !== agent.id) links.push({ id: `team:${agent.id}:${delegate}`, source: `agent:${agent.id}`, target: `agent:${delegate}`, kind: 'team' })
    }
    if (agent.tools.includes('mcp')) {
      for (const server of agent.mcpServers ?? []) {
        usedServers.add(server)
        links.push({ id: `uses:${agent.id}:mcp:${server}`, source: `agent:${agent.id}`, target: `connector:${server}`, kind: 'uses' })
      }
    }
    for (const tool of CAPABILITIES) {
      if (agent.tools.includes(tool)) {
        usedTools.add(tool)
        links.push({ id: `uses:${agent.id}:${tool}`, source: `agent:${agent.id}`, target: `capability:${tool}`, kind: 'uses' })
      }
    }
  }
  for (const server of servers) if (usedServers.has(server.id)) nodes.push({ id: `connector:${server.id}`, kind: 'connector', label: server.name })
  for (const tool of CAPABILITIES) if (usedTools.has(tool)) nodes.push({ id: `capability:${tool}`, kind: 'capability', label: capabilityLabel(tool), tool })
  // Un lien vers un connecteur inconnu (supprimé, non visible) n'est pas dessiné.
  const ids = new Set(nodes.map((node) => node.id))
  return { nodes, links: links.filter((link) => ids.has(link.source) && ids.has(link.target)) }
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
