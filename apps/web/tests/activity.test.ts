import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { activityCounts, currentStep, formatDuration, foundBy, readCitation, stepTree, uniqueHosts } from '../src/lib/activity'
import { parseInline } from '../src/lib/markdown'
import { locatePassage } from '../src/lib/document-view'
import type { AgentStep } from '../src/lib/api'

const step = (id: string, name: string, extra: Partial<AgentStep> = {}): AgentStep => ({ id, name, status: 'done', ...extra })

describe('Activité : citations, provenance, fil des étapes', () => {
  it('citations : [1], [1, 3] et [1][2] regroupés ; jamais un lien Markdown ni un texte entre crochets', () => {
    assert.deepEqual(readCitation('[1] suite'), { numbers: [1], length: 3 })
    assert.deepEqual(readCitation('[1, 3][3][4].'), { numbers: [1, 3, 4], length: 12 })
    assert.equal(readCitation('[1](https://x.example)'), null)
    assert.equal(readCitation('[note]'), null)
    assert.equal(readCitation('[0]'), null)
    const nodes = parseInline('Kane [1][2]. Voir [le site](https://lemonde.fr) et [3]')
    assert.deepEqual(
      nodes.map((node) => node.type),
      ['text', 'cite', 'text', 'link', 'text', 'cite'],
    )
    assert.deepEqual((nodes[1] as { numbers: number[] }).numbers, [1, 2])
    // Code : les crochets restent du texte.
    assert.equal(parseInline('`a[1]`')[0]!.type, 'code')
  })

  it('arbre : les étapes d’un sous-agent sous sa délégation ; étape en cours la plus récente', () => {
    const steps = [step('d1', 'delegate_task', { status: 'running' }), step('d1/k1', 'search_knowledge', { parent: 'd1', agent: 'RH' }), step('d1/w', 'save_to_knowledge', { parent: 'd1', agent: 'RH', status: 'running' })]
    const tree = stepTree(steps)
    assert.equal(tree.length, 1)
    assert.deepEqual(tree[0]!.children.map((child) => child.id), ['d1/k1', 'd1/w'])
    assert.equal(currentStep(steps)!.id, 'd1/w')
    assert.deepEqual(activityCounts(steps).agents, new Set(['RH']))
  })

  it('provenance : la première étape qui a trouvé chaque source ; sous-agents ignorés (autre numérotation)', () => {
    const map = foundBy([step('s', 'web_search', { found: [1, 2] }), step('r', 'read_webpage', { found: [1] }), step('d/x', 'web_search', { parent: 'd', found: [3] })])
    assert.equal(map.get(1)!.id, 's')
    assert.equal(map.get(2)!.id, 's')
    assert.equal(map.has(3), false)
  })

  it('durées et domaines lisibles', () => {
    assert.equal(formatDuration(1_400, 'fr'), '1,4 s')
    assert.equal(formatDuration(12_000), '12 s')
    assert.equal(formatDuration(65_000), '1 min 05')
    assert.equal(formatDuration(-1), '')
    assert.deepEqual(uniqueHosts([{ url: 'https://www.lemonde.fr/a' }, { url: 'https://lemonde.fr/b' }, { url: null }, { url: 'https://uefa.com/' }]), ['lemonde.fr', 'uefa.com'])
  })

  it('passage cité retrouvé malgré les espaces et l’extrait tronqué ; rien si le document a changé', () => {
    const passages = [{ text: 'Champ : tous les déplacements.' }, { text: 'Le plafond de nuit est de 120 € à Paris.  Au-delà, accord du manager.' }]
    assert.deepEqual(locatePassage(passages, 'Le plafond de nuit est de 120 € à Paris.'), { index: 1, start: 0, length: 40 })
    assert.equal(locatePassage(passages, 'le PLAFOND   de nuit est de 120 €…')!.index, 1)
    assert.equal(locatePassage(passages, 'Texte qui n’existe plus dans le document.'), null)
    assert.equal(locatePassage(passages, 'court'), null)
    assert.equal(locatePassage(passages, null), null)
  })
})
