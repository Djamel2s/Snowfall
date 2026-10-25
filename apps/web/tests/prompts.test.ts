import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { askedVariables, automaticValues, fillPrompt, promptVariables, slashQuery } from '../src/lib/prompts.ts'

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

  it('variables automatiques : jamais demandées, remplies à l’insertion ; une valeur saisie prime', () => {
    assert.deepEqual(askedVariables('Le {{date}}, pour {{ Utilisateur }} : {{sujet}} ({{current_user}})'), ['sujet'])
    const automatic = automaticValues({ now: new Date(2026, 9, 25, 9, 5), locale: 'fr', user: 'Camille' })
    assert.equal(fillPrompt('{{jour}} {{DATE}} à {{heure}}, {{utilisateur}}', {}, automatic), 'dimanche 25 octobre 2026 à 09:05, Camille')
    assert.equal(fillPrompt('{{current_date}} / {{date}}', { date: 'demain' }, automatic), '25 octobre 2026 / demain')
    // Une valeur automatique contenant {{…}} n'est pas réinterprétée.
    assert.equal(fillPrompt('{{utilisateur}} {{sujet}}', { sujet: 'x' }, { utilisateur: '{{sujet}}' }), '{{sujet}} x')
  })
})
