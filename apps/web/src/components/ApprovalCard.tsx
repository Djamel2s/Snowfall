import { useState } from 'react'
import { Check, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import type { ToolApproval } from '../lib/api'
import { useI18n } from '../lib/i18n'

/**
 * Demande d'accord. Le contenu vient du modèle : affiché en texte brut (aucun
 * lien, aucun rendu Markdown) pour qu'il ne puisse rien déguiser.
 */
export default function ApprovalCard({ approval, onDecide }: { approval: ToolApproval; onDecide: (approvalId: string, approved: boolean) => Promise<void> }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const decide = async (approved: boolean) => {
    setBusy(true)
    setFailed(false)
    try {
      await onDecide(approval.id, approved)
    } catch {
      // Demande expirée ou réponse terminée : le serveur a déjà refusé.
      setFailed(true)
      setBusy(false)
    }
  }
  return (
    <div className="approval-card" role="group" aria-label={t('agent.approvalTitle')}>
      <p className="approval-title">
        <ShieldCheck size={13} />
        {t('agent.approvalTitle')}
      </p>
      {approval.warning && (
        <p className="approval-warning" role="alert">
          <TriangleAlert size={13} />
          {t('agent.approvalWarning')}
        </p>
      )}
      {approval.exposure && <p className="approval-exposure">{t('agent.approvalExposure')}</p>}
      {approval.onBehalfOf && <p className="approval-behalf">{t('agent.onBehalfOf', { name: approval.onBehalfOf })}</p>}
      <p className="approval-subject">{approval.title}</p>
      {approval.detail && <pre className="approval-detail">{approval.detail}</pre>}
      {failed && <p className="approval-error">{t('agent.approvalExpired')}</p>}
      <div className="approval-actions">
        <button type="button" className="approval-deny" disabled={busy} onClick={() => void decide(false)}>
          <X size={13} />
          {t('agent.deny')}
        </button>
        <button type="button" className="approval-approve" disabled={busy} onClick={() => void decide(true)}>
          <Check size={13} />
          {t('agent.approve')}
        </button>
      </div>
    </div>
  )
}
