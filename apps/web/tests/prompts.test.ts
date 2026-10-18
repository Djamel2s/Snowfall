import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fillPrompt, promptVariables, slashQuery } from '../src/lib/prompts.ts'

describe('prompts : variables et « / »', () => {
  it('variables dans l’ordre, sans doublon, espaces tolérés', () => {
    assert.deepEqual(promptVariables('Traduis en {{ langue }} : {{texte}} ({{langue}})'), ['langue', 'texte'])
    assert.deepEqual(promptVariables('Aucune {variable} ici {{}}'), [])
  })

  it('remplissage : valeur insérée telle quelle (jamais réinterprétée), vide si absente', () => {
    assert.equal(fillPrompt('En {{langue}} : {{texte}}', { langue: 'anglais' }), 'En anglais : ')
    // Une valeur contenant {{…}} n'est pas remplacée à son tour.
    assert.equal(fillPrompt('{{a}} et {{b}}', { a: '{{b}}', b: 'x' }), '{{b}} et x')
  })

  it('« / » seulement en début de saisie, sur un mot', () => {
    assert.equal(slashQuery('/tra'), 'tra')
    assert.equal(slashQuery('/'), '')
    assert.equal(slashQuery('texte /tra'), null)
    assert.equal(slashQuery('/tra duction'), null)
    assert.equal(slashQuery('/chemin/fichier'), null)
  })
})
