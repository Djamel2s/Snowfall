import { useEffect, useState } from 'react'
import { api, type AgentTemplate } from '../lib/api'

/** Modèles du catalogue (chargés une fois par ouverture du panneau). */
export function useAgentTemplates(onError: (message: string) => void) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  useEffect(() => {
    let cancelled = false
    api
      .listAgentTemplates()
      .then((items) => !cancelled && setTemplates(items))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [onError])
  return templates
}
