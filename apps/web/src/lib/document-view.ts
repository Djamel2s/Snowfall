import { createContext, useContext } from 'react'
import type { MessageSource } from './api'

/** Ouvre un document cité dans le panneau, à l'endroit du passage (fourni par l'application). */
export const DocumentViewer = createContext<((source: MessageSource) => void) | null>(null)

export const useDocumentViewer = () => useContext(DocumentViewer)

const flat = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Passage cité retrouvé dans le document : celui qui contient le début de
 * l'extrait (espaces et casse ignorés), avec la position de l'extrait dans son
 * texte quand elle est exacte. null : pas retrouvé (document modifié depuis).
 */
export function locatePassage(passages: { text: string }[], excerpt: string | null | undefined) {
  if (!excerpt) return null
  // Extrait borné par « … » à l'enregistrement : on cherche son début, assez long pour être unique.
  const probe = flat(excerpt.replace(/…$/, '')).slice(0, 80)
  if (probe.length < 8) return null
  for (const [index, passage] of passages.entries()) {
    if (!flat(passage.text).includes(probe)) continue
    const start = passage.text.indexOf(excerpt.replace(/…$/, '').slice(0, 80))
    return { index, start: start >= 0 ? start : null, length: Math.min(excerpt.replace(/…$/, '').length, passage.text.length) }
  }
  return null
}
