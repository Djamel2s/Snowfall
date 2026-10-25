import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseInline, parseMarkdown } from '../src/lib/markdown.ts'

describe('Markdown : formules', () => {
  const maths = (source: string) => parseInline(source).filter((node) => node.type === 'math')

  it('\\( \\), \\[ \\], $$ $$ et $ $ deviennent des formules', () => {
    assert.deepEqual(maths('Soit \\(x^2\\) et \\[\\int_0^1 f\\]'), [
      { type: 'math', tex: 'x^2', display: false },
      { type: 'math', tex: '\\int_0^1 f', display: true },
    ])
    assert.deepEqual(maths('Aire $\\pi r^2$ ou $$E=mc^2$$'), [
      { type: 'math', tex: '\\pi r^2', display: false },
      { type: 'math', tex: 'E=mc^2', display: true },
    ])
    assert.deepEqual(parseMarkdown('$$\na+b\n$$'), [{ type: 'math', tex: 'a+b' }])
    assert.deepEqual(parseMarkdown('\\[\n\\frac{1}{2}\n\\]'), [{ type: 'math', tex: '\\frac{1}{2}' }])
  })

  it('les montants restent du texte (règles de Pandoc)', () => {
    for (const text of ['Coût : 5 $ et 10 $.', 'De $5 à $10 par mois', 'Prix $ 20', 'Échappé \\$x$']) assert.deepEqual(maths(text), [], text)
  })

  it('formule non fermée : texte ; texte piégé : temps borné', () => {
    assert.deepEqual(maths('\\( jamais fermée'), [])
    const started = performance.now()
    parseInline('$a '.repeat(20_000))
    parseInline('\\( '.repeat(20_000))
    assert.ok(performance.now() - started < 1_000)
  })
})
