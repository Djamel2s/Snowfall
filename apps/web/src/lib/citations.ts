import { createContext, useContext } from 'react'
import type { AgentStep, MessageSource } from './api'
import { foundBy } from './activity'

/**
 * Sources d'une réponse, pour rendre ses citations [n] : la source elle-même,
 * et l'étape qui l'a trouvée (provenance). Absent : les [n] restent du texte.
 */
export type CitationScope = {
  sources: Map<number, MessageSource>
  foundBy: Map<number, AgentStep>
  /** Toutes les sources consultées (pour retrouver le site d'une étape « lecture »). */
  consulted: Map<number, MessageSource>
  /** Signaler une citation douteuse (réponse enregistrée seulement) : devient un 👎 commenté. */
  report?: ((source: MessageSource, reason: CitationIssue) => Promise<void>) | undefined
}

export type CitationIssue = 'mismatch' | 'unreliable'

export const Citations = createContext<CitationScope | null>(null)

export const useCitations = () => useContext(Citations)

export function citationScope(sources: MessageSource[] = [], steps: AgentStep[] = [], consulted: MessageSource[] = [], report?: CitationScope['report']): CitationScope {
  const all = new Map<number, MessageSource>()
  for (const source of consulted) all.set(source.n, source)
  for (const source of sources) all.set(source.n, source)
  return { sources: new Map(sources.map((source) => [source.n, source])), foundBy: foundBy(steps), consulted: all, report }
}
