import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { highlight } from '../src/lib/highlight.ts'

describe('Coloration syntaxique (Prism, en jetons)', () => {
  it('reconnaît les langages courants et leurs alias ; reconstruit le texte à l’identique', () => {
    const code = 'def aire(r):\n    return 3.14 * r ** 2  # cercle'
    const tokens = highlight(code, 'py')!
    assert.equal(tokens.map((token) => token.text).join(''), code)
    assert.ok(tokens.some((token) => token.types.includes('keyword') && token.text === 'def'))
    assert.ok(tokens.some((token) => token.types.includes('comment')))
    for (const lang of ['ts', 'sql', 'bash', 'json', 'html', 'rust', 'go', 'yaml', 'csharp', 'php']) assert.ok(highlight('x', lang), lang)
  })

  it('langage inconnu ou code démesuré : null (repli)', () => {
    assert.equal(highlight('x', 'brainfuck-inconnu'), null)
    assert.equal(highlight('x'.repeat(70_000), 'js'), null)
  })

  it('du HTML dans le code reste du texte (jamais interprété)', () => {
    const tokens = highlight('<img src=x onerror=alert(1)>', 'html')!
    assert.equal(tokens.map((token) => token.text).join(''), '<img src=x onerror=alert(1)>')
  })
})
