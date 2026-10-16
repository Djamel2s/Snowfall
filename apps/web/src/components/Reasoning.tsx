import { useState } from 'react'
import { Brain, ChevronRight, LoaderCircle } from 'lucide-react'
import { useI18n } from '../lib/i18n'

type Props = {
  text: string
  /** Le modèle réfléchit encore (la réponse n'a pas commencé). */
  thinking?: boolean
}

/**
 * Réflexion du modèle (résumée par le fournisseur) : ouverte pendant qu'il
 * réfléchit, repliée dès que la réponse commence. Texte brut, sans rendu :
 * c'est un aperçu du raisonnement, pas la réponse. Jamais enregistrée.
 */
export default function Reasoning({ text, thinking = false }: Props) {
  const { t } = useI18n()
  // Ouverte tant qu'il réfléchit, ensuite seulement si tu la déplies.
  const [expanded, setExpanded] = useState(false)
  const open = thinking || expanded

  return (
    <div className={`reasoning ${open ? 'open' : ''}`}>
      <button type="button" className="reasoning-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
        <ChevronRight size={12} className="reasoning-chevron" />
        <Brain size={12} />
        {thinking ? t('agent.reasoningLive') : t('agent.reasoning')}
        {thinking && <LoaderCircle size={11} className="spin" />}
      </button>
      {open && <p className="reasoning-text">{text}</p>}
    </div>
  )
}
