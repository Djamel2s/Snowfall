import { useEffect, useRef, useState } from 'react'

// Formule LaTeX rendue par KaTeX en MathML (format natif des navigateurs) : KaTeX
// construit les nœuds lui-même, sans HTML brut ni style en ligne, et sans
// commande dangereuse (trust: false refuse \href, \url, \includegraphics…).
// Chargé seulement quand une formule apparaît (KaTeX pèse ~260 Ko).

type Katex = typeof import('katex')
let loading: Promise<Katex> | null = null
const load = () => (loading ??= import('katex').then((module) => (module.default ?? module) as unknown as Katex))

export default function MathFormula({ tex, display }: { tex: string; display: boolean }) {
  // Cible réservée à KaTeX : React ne lui donne jamais d'enfants (pas de conflit).
  const target = useRef<HTMLSpanElement>(null)
  const [state, setState] = useState<'loading' | 'done' | 'failed'>('loading')

  useEffect(() => {
    let cancelled = false
    load()
      .then((katex) => {
        if (cancelled || !target.current) return
        katex.render(tex, target.current, {
          displayMode: display,
          output: 'mathml',
          throwOnError: false,
          trust: false,
          strict: 'ignore',
          // Bornes contre une formule piégée (taille, macros récursives).
          maxSize: 20,
          maxExpand: 200,
        })
        setState('done')
      })
      .catch(() => !cancelled && setState('failed'))
    return () => {
      cancelled = true
    }
  }, [tex, display])

  // Avant le rendu (ou en cas d'échec) : la source, lisible.
  return (
    <span className={`md-math${display ? ' md-math-display' : ''}`}>
      <span ref={target} />
      {state !== 'done' && <code>{tex}</code>}
    </span>
  )
}
