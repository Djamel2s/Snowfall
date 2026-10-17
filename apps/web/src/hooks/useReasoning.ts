import { useRef, useState } from 'react'

/**
 * Réflexion du modèle : en direct pendant la réponse, puis rattachée à elle
 * (cette session seulement : elle n'est jamais enregistrée).
 */
export function useReasoning() {
  const [reasoning, setReasoning] = useState('')
  const reasoningRef = useRef('')
  const [reasoningByMessage, setReasoningByMessage] = useState<Record<string, string>>({})

  /** Fragment reçu pendant la réponse. */
  const onReasoning = (text: string) => {
    reasoningRef.current += text
    setReasoning(reasoningRef.current)
  }
  /** Remplace la réflexion affichée (reconnexion, nouvelle réponse). */
  const showReasoning = (text: string) => {
    reasoningRef.current = text
    setReasoning(text)
  }
  /** Réponse terminée : la réflexion reste consultable sous elle. */
  const keepReasoning = (messageId: string) => {
    const thought = reasoningRef.current
    if (thought) setReasoningByMessage((current) => ({ ...current, [messageId]: thought }))
  }

  return { reasoning, reasoningByMessage, onReasoning, showReasoning, keepReasoning }
}
