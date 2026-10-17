import { useCallback, useState } from 'react'
import { api, type GeneratedFile } from '../lib/api'

/** Fichiers produits par l'interpréteur de code, par conversation. */
export function useGeneratedFiles() {
  const [generatedFiles, setGeneratedFiles] = useState<Record<string, GeneratedFile[]>>({})
  const refreshFiles = useCallback(
    (conversationId: string) =>
      api
        .listGeneratedFiles(conversationId)
        .then((files) => setGeneratedFiles((current) => ({ ...current, [conversationId]: files })))
        .catch(() => undefined),
    [],
  )
  return { generatedFiles, refreshFiles }
}
