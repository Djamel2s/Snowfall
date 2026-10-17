import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { artifactFileName, artifactKind, artifactsIn, artifactTitle, wantsCode } from '../src/lib/artifacts.ts'
import { repairMermaid } from '../src/lib/mermaid-repair.ts'

describe('Artifacts : détection', () => {
  it('reconnaît les blocs affichables, et seulement eux', () => {
    assert.equal(artifactKind('html', '<p>x</p>'), 'html')
    assert.equal(artifactKind('svg', '<svg></svg>'), 'svg')
    assert.equal(artifactKind('xml', '  <svg viewBox="0 0 1 1"></svg>'), 'svg')
    assert.equal(artifactKind('xml', '<note/>'), null)
    assert.equal(artifactKind('mermaid', 'flowchart LR; A-->B'), 'mermaid')
    assert.equal(artifactKind('js', 'alert(1)'), null)
    assert.equal(artifactKind('', '<html></html>'), null)
  })

  it('titre : celui de la page, sinon le type', () => {
    assert.equal(artifactTitle('html', '<html><head><title> Budget 2026 </title></head></html>'), 'Budget 2026')
    assert.equal(artifactTitle('html', '<p>sans titre</p>'), 'Page HTML')
    assert.equal(artifactTitle('mermaid', 'flowchart LR; A-->B'), 'Diagramme')
  })
})

describe('Artifacts : réponse', () => {
  it('liste les artifacts de la réponse (y compris dans une liste), pas le code ordinaire', () => {
    const answer = 'Voici :\n\n```mermaid\nflowchart LR; A-->B\n```\n\n- détail :\n\n  ```svg\n  <svg></svg>\n  ```\n\n```python\nprint(1)\n```'
    assert.deepEqual(artifactsIn(answer).map((item) => item.kind), ['mermaid', 'svg'])
    assert.deepEqual(artifactsIn('Pas de bloc.'), [])
  })

  it('code déplié seulement si la question le demande', () => {
    assert.equal(wantsCode('Montre-moi le code du diagramme'), true)
    assert.equal(wantsCode('Donne la source HTML'), true)
    assert.equal(wantsCode('Fais un diagramme mermaid de mes notes'), false)
  })

  it('nom de fichier : titre simplifié et extension selon le contenu', () => {
    assert.equal(artifactFileName({ kind: 'html', title: 'Budget 2026 — Été' }), 'budget-2026-ete.html')
    assert.equal(artifactFileName({ kind: 'mermaid', title: 'Diagramme' }, true), 'diagramme.svg')
    assert.equal(artifactFileName({ kind: 'mermaid', title: 'Diagramme' }), 'diagramme.mmd')
    assert.equal(artifactFileName({ kind: 'svg', title: '…' }), 'artifact.svg')
  })
})

// Résultats vérifiés avec le vrai Mermaid (12.1) : l'original est refusé, la réparation acceptée.
describe('Artifacts : réparation Mermaid', () => {
  it('met entre guillemets les libellés des nœuds, liens et sous-graphes', () => {
    assert.equal(
      repairMermaid('graph TD\n  C[Studette G (Loyer / Charges)<br>316,00 €]:::debit --> F(( ))\n  B -->|Total dû : 462 €| F'),
      'graph TD\n  C["Studette G (Loyer / Charges)<br>316,00 €"]:::debit --> F(( ))\n  B -->|"Total dû : 462 €"| F',
    )
    assert.equal(repairMermaid('flowchart LR; A[Loyer (charges)] --> B{Payé ?}'), 'flowchart LR; A["Loyer (charges)"] --> B{"Payé ?"}')
    assert.equal(
      repairMermaid('flowchart TB\n  subgraph Période : août\n  a --> b\n  end\n  subgraph one [Titre]\n  end'),
      'flowchart TB\n  subgraph sg1["Période : août"]\n  a --> b\n  end\n  subgraph one["Titre"]\n  end',
    )
  })

  it('garde les formes, les guillemets existants et les lignes de style', () => {
    assert.equal(
      repairMermaid('flowchart LR\n  A["déjà (cité)"] --> B[/trapèze/]\n  C[[sous (x)]] --> D[(Base)] --> E{{h}} --> F>asym]'),
      'flowchart LR\n  A["déjà (cité)"] --> B[/trapèze/]\n  C[["sous (x)"]] --> D[("Base")] --> E{{"h"}} --> F>"asym"]',
    )
    assert.equal(repairMermaid('flowchart LR\n  classDef c fill:#f9f\n  B[c "d"]'), 'flowchart LR\n  classDef c fill:#f9f\n  B["c #quot;d#quot;"]')
  })

  it('ne touche pas aux autres types de diagrammes', () => {
    const sequence = 'sequenceDiagram\n  Alice->>Bob: Bonjour (test)'
    assert.equal(repairMermaid(sequence), sequence)
  })
})
