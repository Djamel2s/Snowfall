import { createContext, useContext } from 'react'
import { parseMarkdown, type Block } from './markdown'

/** Contenus affichables dans le cadre isolé des artifacts. */
export type ArtifactKind = 'html' | 'svg' | 'mermaid'

export type Artifact = { kind: ArtifactKind; source: string; title: string }

/** Bloc de code → artifact, selon son langage (```html, ```svg, ```mermaid). */
export function artifactKind(lang: string, text: string): ArtifactKind | null {
  if (lang === 'html' || lang === 'htm') return 'html'
  if (lang === 'svg' || (lang === 'xml' && /^\s*<svg[\s>]/i.test(text))) return 'svg'
  if (lang === 'mermaid' || lang === 'mmd') return 'mermaid'
  return null
}

/** Titre lisible : <title> d'une page, sinon le type. */
export function artifactTitle(kind: ArtifactKind, source: string) {
  const title = kind === 'html' ? /<title[^>]*>([^<]{1,120})<\/title>/i.exec(source)?.[1]?.trim() : undefined
  return title || { html: 'Page HTML', svg: 'Image SVG', mermaid: 'Diagramme' }[kind]
}

/** Artifacts d'une réponse, dans l'ordre (blocs de code affichables, même dans une liste ou une citation). */
export function artifactsIn(markdown: string): Artifact[] {
  const found: Artifact[] = []
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === 'code') {
        const kind = artifactKind(block.lang, block.text)
        if (kind) found.push({ kind, source: block.text, title: artifactTitle(kind, block.text) })
      } else if (block.type === 'quote') walk(block.children)
      else if (block.type === 'list') block.items.forEach(walk)
    }
  }
  walk(parseMarkdown(markdown))
  return found
}

/** La question demande-t-elle le code lui-même ? (sinon les artifacts s'affichent repliés) */
export const wantsCode = (question: string) => /\b(code|codes|source|sources|syntaxe)\b/i.test(question)

/** Nom du fichier téléchargé : titre simplifié + extension du type. */
export function artifactFileName(artifact: Pick<Artifact, 'kind' | 'title'>, rendered = false) {
  const base =
    artifact.title
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'artifact'
  const extension = artifact.kind === 'html' ? 'html' : artifact.kind === 'svg' || rendered ? 'svg' : 'mmd'
  return `${base}.${extension}`
}

/** Ouverture d'un artifact dans le panneau (fournie par l'application). */
export const ArtifactContext = createContext<((artifact: Artifact) => void) | null>(null)
export const useOpenArtifact = () => useContext(ArtifactContext)
