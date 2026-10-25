import { useState } from 'react'
import { Ban, Check, FileSearch, Globe, GraduationCap, ImagePlus, LoaderCircle, PenLine, Plug, Search, ShieldCheck, SquareTerminal, TriangleAlert, Users, Wrench, X } from 'lucide-react'
import type { AgentStep, ToolApproval } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Props = {
  steps: AgentStep[]
  /** Ta décision sur une action d'écriture en attente. */
  onDecide?: (approvalId: string, approved: boolean) => Promise<void>
}

/** Ce que fait l'agent pendant la réponse : chaque outil appelé, et son état. */
export default function AgentSteps({ steps, onDecide }: Props) {
  const { t } = useI18n()
  return (
    <ul className="agent-steps" aria-label={t('agent.steps')} aria-live="polite">
      {steps.map((step) => {
        const Icon =
          step.name === 'search_knowledge'
            ? Search
            : step.name === 'save_to_knowledge'
              ? PenLine
              : step.name === 'web_search'
                ? Globe
                : step.name === 'read_webpage'
                  ? FileSearch
                  : step.name === 'run_code'
                    ? SquareTerminal
                    : step.name.startsWith('mcp_')
                      ? Plug
                      : step.name === 'delegate_task'
                        ? Users
                        : step.name === 'generate_image'
                          ? ImagePlus
                          : step.name === 'use_skill' || step.name === 'read_skill_file'
                            ? GraduationCap
                            : Wrench
        const label =
          step.name === 'search_knowledge'
            ? t('agent.searchKnowledge')
            : step.name === 'save_to_knowledge'
              ? t('agent.saveKnowledge')
              : step.name === 'web_search'
                ? t('agent.webSearch')
                : step.name === 'read_webpage'
                  ? t('agent.readWebpage')
                  : step.name === 'run_code'
                    ? t('agent.runCode')
                    : step.name.startsWith('mcp_')
                      ? t('agent.mcpTool', { name: step.name.slice(4) })
                      : step.name === 'delegate_task'
                        ? t('agent.delegate')
                        : step.name === 'generate_image'
                          ? t('agent.generateImage')
                          : step.name === 'use_skill'
                            ? t('agent.useSkill')
                            : step.name === 'read_skill_file'
                              ? t('agent.readSkillFile')
                              : t('agent.tool', { name: step.name })
        const waiting = step.status === 'running' && step.approval
        return (
          <li key={step.id} className={`agent-step agent-step-${step.status}${step.parent ? ' agent-step-nested' : ''}`} style={step.parent ? { marginLeft: `${Math.min(3, step.parent.split('/').length) * 14}px` } : undefined}>
            <span className="agent-step-line">
              {step.agent && <span className="agent-step-agent">{step.agent}</span>}
              <Icon size={12} />
              <span className="agent-step-label">{label}</span>
              {step.summary && <span className="agent-step-summary">« {step.summary} »</span>}
              {waiting ? (
                <ShieldCheck size={12} />
              ) : step.status === 'running' ? (
                <LoaderCircle size={12} className="spin" />
              ) : step.status === 'error' ? (
                <TriangleAlert size={12} />
              ) : step.status === 'denied' ? (
                <Ban size={12} aria-label={t('agent.denied')} />
              ) : (
                <Check size={12} />
              )}
            </span>
            {waiting && onDecide && <ApprovalCard approval={step.approval!} onDecide={onDecide} />}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Demande d'accord. Le contenu vient du modèle : affiché en texte brut (aucun
 * lien, aucun rendu Markdown) pour qu'il ne puisse rien déguiser.
 */
function ApprovalCard({ approval, onDecide }: { approval: ToolApproval; onDecide: NonNullable<Props['onDecide']> }) {
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
