import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Agent, ProviderCatalog } from '../src/lib/api.ts'
import { mentionAt, resolveResponder, responderOptions } from '../src/lib/responder.ts'

const agent = (id: string, name: string): Agent =>
  ({ id, name, provider: 'mistral', model: 'mistral-small-latest', avatar: { kind: 'alien' } }) as unknown as Agent

const providers: ProviderCatalog[] = [
  { id: 'mistral', available: true, allowed: true, models: [{ id: 'mistral-small-latest', label: 'Mistral Small' }] },
  { id: 'anthropic', available: true, allowed: false, models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet' }] },
  { id: 'google', available: false, models: [] },
]

describe('Mention « @ » dans le message', () => {
  it('détecte @ en début de texte ou après une espace, jusqu’au curseur', () => {
    assert.deepEqual(mentionAt('@jur', 4), { start: 0, query: 'jur' })
    assert.deepEqual(mentionAt('Bonjour @', 9), { start: 8, query: '' })
    assert.deepEqual(mentionAt('Bonjour @gem et', 12), { start: 8, query: 'gem' })
  })

  it('ignore une adresse e-mail ou une mention terminée', () => {
    assert.equal(mentionAt('ecris a jean@exemple.fr', 23), null)
    assert.equal(mentionAt('@jur ', 5), null)
  })
})

describe('Liste des agents et modèles', () => {
  it('agents d’abord, puis seulement les modèles autorisés et configurés', () => {
    const options = responderOptions([agent('a1', 'Juriste RGPD')], providers, '')
    assert.deepEqual(options.map((option) => option.key), ['agent:a1', 'model:mistral:mistral-small-latest'])
  })

  it('filtre sans tenir compte des accents ni de la casse', () => {
    const options = responderOptions([agent('a1', 'Équipe juridique'), agent('a2', 'Dev')], providers, 'EQUIPE')
    assert.deepEqual(options.map((option) => option.key), ['agent:a1'])
    assert.equal(responderOptions([], providers, 'mistral').length, 1)
  })

  it('résout agent, modèle choisi, puis modèle par défaut', () => {
    const agents = [agent('a1', 'Juriste')]
    assert.equal(resolveResponder({ agentId: 'a1', model: null }, agents, providers, null).kind, 'agent')
    const chosen = resolveResponder({ agentId: null, model: { provider: 'mistral', model: 'mistral-small-latest' } }, agents, providers, null)
    assert.deepEqual(chosen, { kind: 'model', provider: 'mistral', model: 'mistral-small-latest', label: 'Mistral Small' })
    // Agent supprimé : repli sur le défaut.
    const fallback = resolveResponder({ agentId: 'disparu', model: null }, agents, providers, { provider: 'anthropic', model: 'x' })
    assert.deepEqual(fallback, { kind: 'model', provider: 'anthropic', model: 'x', label: 'x' })
    assert.equal(resolveResponder(undefined, agents, providers, null).kind, 'default')
  })
})
