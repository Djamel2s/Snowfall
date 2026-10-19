import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentInput, buildAgentGraph, canAddToTeam, neighbors } from '../src/lib/agent-graph.ts'
import type { Agent } from '../src/lib/api.ts'

const agent = (id: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, name: id.toUpperCase(), avatar: { kind: 'alien', color: 'sky', eyes: 'classic', accessory: 'none' }, instructions: '', provider: 'mistral', model: 'm', tools: ['search_knowledge'], mcpServers: [], delegates: [], createdBy: 'u', canEdit: true, ...extra }) as Agent

describe('carte des agents', () => {
  it('liens d’équipe, connecteurs et capacités ; rien vers un agent inconnu ni vers soi', () => {
    const agents = [agent('a', { tools: ['delegate', 'web_search', 'mcp'], delegates: ['b', 'a', 'ghost'], mcpServers: ['s1', 's9'] }), agent('b')]
    const graph = buildAgentGraph(agents, [{ id: 's1', name: 'Jira', status: 'approved', tools: [] }], (tool) => tool)
    assert.deepEqual(graph.links.map((link) => link.id).sort(), ['team:a:b', 'uses:a:mcp:s1', 'uses:a:web_search'])
    assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ['agent:a', 'agent:b', 'capability:web_search', 'connector:s1'])
    assert.deepEqual([...neighbors(graph.links, 'agent:b')].sort(), ['agent:a', 'agent:b'])
  })

  it('ajout à l’équipe : modifiable, pas soi-même, pas en double, 5 au plus ; l’outil de délégation est activé', () => {
    const owner = agent('a', { delegates: ['b'] })
    assert.equal(canAddToTeam(owner, agent('c')), true)
    assert.equal(canAddToTeam(owner, owner), false)
    assert.equal(canAddToTeam(owner, agent('b')), false)
    assert.equal(canAddToTeam(agent('a', { canEdit: false }), agent('c')), false)
    assert.equal(canAddToTeam(agent('a', { delegates: ['1', '2', '3', '4', '5'] }), agent('c')), false)
    assert.ok(agentInput(owner, ['b', 'c']).tools.includes('delegate'))
  })
})
