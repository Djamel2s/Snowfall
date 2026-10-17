import { useCallback, useRef, useState } from 'react'
import type { Artifact, OpenedArtifact } from '../lib/artifacts'

/**
 * Artifact affiché à côté de la conversation (page HTML, SVG, diagramme).
 * Chaque ouverture reçoit un numéro : le panneau est recréé, jamais de mode
 * « Exécuter » hérité d'un autre artifact.
 */
export function useArtifactPanel() {
  const [artifact, setArtifact] = useState<OpenedArtifact | null>(null)
  const openings = useRef(0)
  const openArtifact = useCallback((next: Artifact) => setArtifact({ ...next, opening: ++openings.current }), [])
  const closeArtifact = useCallback(() => setArtifact(null), [])
  return { artifact, openArtifact, closeArtifact }
}
