import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isTrustedLink, trustedHosts } from '../src/lib/link-trust.ts'

describe('liens des réponses : domaines de confiance', () => {
  const hosts = trustedHosts([
    { role: 'user', content: 'Résume https://www.veille.example.com/rapport stp' },
    { role: 'assistant', content: 'Voir https://attacker.example/x', sources: [{ url: 'https://iso.example/27001' }, { url: null }] },
  ])

  it('domaines écrits par l’utilisateur ou cités en source ; jamais ceux écrits par l’assistant', () => {
    assert.deepEqual([...hosts].sort(), ['iso.example', 'veille.example.com'])
  })

  it('lien cliquable seulement vers un domaine de confiance ou Snowfall lui-même', () => {
    assert.equal(isTrustedLink('https://veille.example.com/autre-page', hosts, 'https://snowfall.example'), true)
    assert.equal(isTrustedLink('https://img.attacker.example/p?d=4407', hosts, 'https://snowfall.example'), false)
    // Un sous-domaine n'hérite pas de la confiance (veille.example.com ≠ evil.veille.example.com).
    assert.equal(isTrustedLink('https://evil.veille.example.com/', hosts, 'https://snowfall.example'), false)
    assert.equal(isTrustedLink('https://snowfall.example/aide', hosts, 'https://snowfall.example'), true)
    assert.equal(isTrustedLink('mailto:x@iso.example', hosts, 'https://snowfall.example'), false)
  })
})
