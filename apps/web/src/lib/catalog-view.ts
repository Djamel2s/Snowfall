import { useState } from 'react'

/** Affichage d'un catalogue : grille d'icônes (défaut) ou liste détaillée. */
export type CatalogView = 'grid' | 'list'

const key = (name: string) => `snowfall.catalog-view.${name}`

/** Choix gardé dans ce navigateur (une préférence d'affichage, rien d'autre). */
export function useCatalogView(name: string) {
  const [view, setView] = useState<CatalogView>(() => {
    try {
      return localStorage.getItem(key(name)) === 'list' ? 'list' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const change = (next: CatalogView) => {
    setView(next)
    try {
      localStorage.setItem(key(name), next)
    } catch {
      // Stockage indisponible (navigation privée) : le choix vaut pour la session.
    }
  }
  return [view, change] as const
}
