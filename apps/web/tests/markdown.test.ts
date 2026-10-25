import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseInline, parseMarkdown, safeHref, tokenizeCode } from '../src/lib/markdown.ts'

describe('Markdown : sécurité', () => {
  it('refuse les liens javascript:, data: et relatifs', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'vbscript:x', '/admin', 'file:///etc/passwd']) {
      assert.equal(safeHref(href), null, href)
    }
    assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1')
    assert.equal(safeHref('mailto:a@b.fr'), 'mailto:a@b.fr')
  })

  it('un lien dangereux devient du texte simple', () => {
    assert.deepEqual(parseInline('[clic](javascript:alert(1))'), [{ type: 'text', text: 'clic' }])
  })

  it('une image n\'est jamais chargée : simple lien vers sa source', () => {
    const nodes = parseInline('![pixel](https://evil.example/x.png?secret=1)')
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]!.type, 'link')
    assert.ok(!JSON.stringify(parseMarkdown('![a](https://x.example/y.png)')).includes('"image"'))
  })

  it('le HTML reste du texte', () => {
    assert.deepEqual(parseMarkdown('<img src=x onerror=alert(1)>'), [
      { type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
    ])
  })

  it('reste rapide sur une entrée malveillante', () => {
    const started = performance.now()
    parseMarkdown(`[a](${'('.repeat(20_000)}`)
    parseMarkdown('*a'.repeat(10_000))
    parseMarkdown(`https://${'a.'.repeat(20_000)}`)
    assert.ok(performance.now() - started < 1_000)
  })
})

describe('Markdown : rendu', () => {
  it('styles en ligne, code et liens automatiques', () => {
    assert.deepEqual(parseInline('**gras** *ital* `code` ~~barré~~ snake_case_var'), [
      { type: 'strong', children: [{ type: 'text', text: 'gras' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'ital' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' ' },
      { type: 'del', children: [{ type: 'text', text: 'barré' }] },
      { type: 'text', text: ' snake_case_var' },
    ])
    assert.equal(parseInline('voir https://snowfall.fr.')[1]!.type, 'link')
  })

  it('titres, listes imbriquées, citation et séparateur', () => {
    const blocks = parseMarkdown('## Titre\n\n- un\n  - sous\n- deux\n\n1. a\n2. b\n\n> cité\n\n---')
    assert.deepEqual(blocks.map((block) => block.type), ['heading', 'list', 'list', 'quote', 'hr'])
    const list = blocks[1] as Extract<(typeof blocks)[number], { type: 'list' }>
    assert.equal(list.items.length, 2)
    assert.equal(list.items[0]![1]!.type, 'list')
    assert.equal((blocks[2] as typeof list).ordered, true)
  })

  it('bloc de code, y compris non refermé pendant le streaming', () => {
    assert.deepEqual(parseMarkdown('```ts\nconst a = 1\n```'), [{ type: 'code', lang: 'ts', text: 'const a = 1' }])
    assert.deepEqual(parseMarkdown('Voici :\n```py\nprint(1)'), [
      { type: 'paragraph', children: [{ type: 'text', text: 'Voici :' }] },
      { type: 'code', lang: 'py', text: 'print(1)' },
    ])
  })

  it('tableau avec alignements', () => {
    const [table] = parseMarkdown('| Nom | Prix |\n|:--|--:|\n| A | 1 |\n| B | 2 |')
    assert.equal(table!.type, 'table')
    if (table!.type !== 'table') return
    assert.deepEqual(table.align, ['left', 'right'])
    assert.equal(table.rows.length, 2)
  })

  it('coloration : mots-clés, chaînes, commentaires', () => {
    const kinds = tokenizeCode('const x = "a" // note', 'ts').filter((token) => token.kind !== 'plain').map((token) => token.kind)
    assert.deepEqual(kinds, ['keyword', 'string', 'comment'])
  })
})

