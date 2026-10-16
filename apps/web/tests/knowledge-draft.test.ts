import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { draftLink, submitKnowledgeDraft as submit, type KnowledgeDraft } from '../src/lib/knowledge-draft.ts'

let client: Parameters<typeof submit>[0]

/** Faux client : journal des appels réseau, dans l'ordre. */
function recordCalls(failOn: string[] = []) {
  const calls: string[] = []
  const step = (name: string) => {
    calls.push(name)
    if (failOn.includes(name)) return Promise.reject(new Error(`refus ${name}`))
    return Promise.resolve({} as never)
  }
  client = {
    setKnowledgeConfidential: () => step('confidential'),
    addKnowledgeFile: (_kind, _id, _file, name) => step(`file:${name}`),
    addKnowledgeLink: (_kind, _id, url) => step(`link:${url}`),
  }
  return calls
}

const submitKnowledgeDraft = (...args: Parameters<typeof submit> extends [unknown, ...infer Rest] ? Rest : never) =>
  submit(client, ...args)

const draft = (confidential: boolean): KnowledgeDraft => ({
  confidential,
  items: [
    { id: 'a', kind: 'file', name: 'rh.pdf', file: new File(['x'], 'rh.pdf') },
    { id: 'b', kind: 'link', name: 'exemple.fr', url: 'https://exemple.fr/' },
  ],
})

describe('Documents en attente à la création d’un agent', () => {
  it('rend la base confidentielle avant le moindre envoi', async () => {
    const calls = recordCalls()
    assert.deepEqual(await submitKnowledgeDraft('agents', 'id', draft(true), 'échec'), [])
    assert.deepEqual(calls, ['confidential', 'file:rh.pdf', 'link:https://exemple.fr/'])
  })

  it('n’envoie rien si le mode confidentiel est refusé', async () => {
    const calls = recordCalls(['confidential'])
    assert.deepEqual(await submitKnowledgeDraft('agents', 'id', draft(true), 'échec'), ['refus confidential'])
    assert.deepEqual(calls, ['confidential'])
  })

  it('continue après un échec et liste ce qui n’est pas passé', async () => {
    const calls = recordCalls(['file:rh.pdf'])
    assert.deepEqual(await submitKnowledgeDraft('agents', 'id', draft(false), 'échec'), ['rh.pdf : refus file:rh.pdf'])
    assert.deepEqual(calls, ['file:rh.pdf', 'link:https://exemple.fr/'])
  })

  it('ne garde que les liens web sans identifiants', () => {
    assert.equal(draftLink(' https://exemple.fr/page '), 'https://exemple.fr/page')
    assert.equal(draftLink('javascript:alert(1)'), null)
    assert.equal(draftLink('ftp://exemple.fr'), null)
    assert.equal(draftLink('https://moi:secret@exemple.fr'), null)
    assert.equal(draftLink('pas un lien'), null)
  })
})
