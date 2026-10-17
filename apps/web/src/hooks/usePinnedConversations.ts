import { useEffect, useState } from 'react'

const KEY = 'snowfall:pinned-conversations'

/** Conversations épinglées : préférence de ce navigateur seulement. */
export function usePinnedConversations() {
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(KEY)
      return saved ? (JSON.parse(saved) as string[]) : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(pinnedIds))
    } catch {
      // Épingles non conservées : sans gravité.
    }
  }, [pinnedIds])

  const togglePinned = (id: string) =>
    setPinnedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [id, ...current]))

  return { pinnedIds, togglePinned }
}
