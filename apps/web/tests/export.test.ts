import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '../src/lib/api'
import { exportFileName, plainText, toText, wrapLines } from '../src/lib/export'

const labels = { user: 'Vous', assistant: 'Assistant', sources: 'Sources' }
const message = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ id: role, role, content, createdAt: '', ...extra })

describe('Export texte', () => {
  it('Markdown allégé : titres, gras, code, liens', () => {
    assert.equal(
      plainText('## Titre\n\nUn **mot** et *autre* `code`.\n\n```python\nprint(1)\n```\n\nVoir [la loi](https://legifrance.gouv.fr).'),
      'Titre\n\nUn mot et autre code.\n\nprint(1)\n\nVoir la loi (https://legifrance.gouv.fr).',
    )
  })

  it('un bloc par intervenant, sources en fin de réponse', () => {
    const text = toText('Congés', [message('user', 'Combien ?'), message('assistant', '**25** jours [1].', { sources: [{ n: 1, sourceId: 's', name: 'accord.pdf', url: null, base: 'agent' } as never] })], labels)
    assert.equal(text, 'Congés\n======\n\nVous :\nCombien ?\n\nAssistant :\n25 jours [1].\n\nSources : [1] accord.pdf\n')
  })

  it('nom de fichier sûr, quelle que soit l’extension', () => {
    assert.equal(exportFileName('Été : bilan / 2026', 'txt'), 'ete-bilan-2026.txt')
    assert.equal(exportFileName('../../', 'png'), 'conversation.png')
  })
})

describe('Export image : découpage des lignes', () => {
  const measure = (value: string) => value.length
  it('coupe aux espaces, garde les paragraphes', () => {
    assert.deepEqual(wrapLines('un deux trois quatre\n\ncinq', 9, measure), ['un deux', 'trois', 'quatre', '', 'cinq'])
  })

  it('un mot plus long que la ligne est coupé au caractère, sans boucle infinie', () => {
    assert.deepEqual(wrapLines('abcdefghij', 4, measure), ['abcd', 'efgh', 'ij'])
    assert.deepEqual(wrapLines('x abcdefghij y', 4, measure), ['x', 'abcd', 'efgh', 'ij y'])
  })
})
