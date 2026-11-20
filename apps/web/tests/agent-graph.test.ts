import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentInput, buildAgentGraph, canAddToTeam, neighbors, orbit, ORBIT } from '../src/lib/agent-graph.ts'
import type { Agent } from '../src/lib/api.ts'

const agent = (id: string, extra: Partial<Agent> = {}): Agent =>
  ({ id, name: id.toUpperCase(), avatar: { kind: 'alien', color: 'sky', eyes: 'classic', accessory: 'none' }, instructions: '', provider: 'mistral', model: 'm', tools: ['search_knowledge'], mcpServers: [], delegates: [], createdBy: 'u', canEdit: true, ...extra }) as Agent

describe('carte des agents', () => {
  it('seuls les liens d’équipe sont des traits ; outils et connecteurs gravitent autour de CHAQUE agent', () => {
    const agents = [
      agent('a', { tools: ['delegate', 'web_search', 'mcp'], delegates: ['b', 'a', 'ghost'], mcpServers: ['s1', 's9'] }),
      agent('b', { tools: ['web_search', 'code_interpreter'] }),
      agent('c'),
    ]
    const graph = buildAgentGraph(agents, [{ id: 's1', name: 'Jira', status: 'approved', tools: [] }], (tool) => tool)
    // Rien vers un agent inconnu ni vers soi ; aucun trait vers un outil.
    assert.deepEqual(graph.links.map((link) => link.id), ['team:a:b'])
    assert.deepEqual(graph.nodes.map((node) => node.id), ['agent:a', 'agent:b', 'agent:c'])
    // La recherche web de A et celle de B sont deux satellites distincts ; connecteur inconnu absent.
    assert.deepEqual(graph.satellites.get('agent:a')?.map((item) => item.id), ['capability:a:web_search', 'connector:a:s1'])
    assert.deepEqual(graph.satellites.get('agent:b')?.map((item) => item.id), ['capability:b:web_search', 'capability:b:code_interpreter'])
    assert.equal(graph.satellites.has('agent:c'), false)
    assert.deepEqual([...neighbors(graph.links, 'agent:b')].sort(), ['agent:a', 'agent:b'])
  })

  it('orbite : satellites répartis à égale distance de l’agent', () => {
    const points = [0, 1, 2].map((index) => orbit(index, 3))
    for (const point of points) assert.ok(Math.abs(Math.hypot(point.x, point.y) - ORBIT) < 1e-9)
    assert.ok(Math.abs(points[0]!.x) < 1e-9 && points[0]!.y < 0)
    const gap = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y)
    assert.ok(Math.abs(gap(points[0]!, points[1]!) - gap(points[1]!, points[2]!)) < 1e-9)
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
