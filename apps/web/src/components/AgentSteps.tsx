import { Check, LoaderCircle, Search, TriangleAlert, Wrench } from 'lucide-react'
import type { AgentStep } from '../lib/api'
import { useI18n } from '../lib/i18n'

/** Ce que fait l'agent pendant la réponse : chaque outil appelé, et son état. */
export default function AgentSteps({ steps }: { steps: AgentStep[] }) {
  const { t } = useI18n()
  return (
    <ul className="agent-steps" aria-label={t('agent.steps')} aria-live="polite">
      {steps.map((step) => {
        const Icon = step.name === 'search_knowledge' ? Search : Wrench
        const label = step.name === 'search_knowledge' ? t('agent.searchKnowledge') : t('agent.tool', { name: step.name })
        return (
          <li key={step.id} className={`agent-step agent-step-${step.status}`}>
            <Icon size={12} />
            <span className="agent-step-label">{label}</span>
            {step.summary && <span className="agent-step-summary">« {step.summary} »</span>}
            {step.status === 'running' ? (
              <LoaderCircle size={12} className="spin" />
            ) : step.status === 'error' ? (
              <TriangleAlert size={12} />
            ) : (
              <Check size={12} />
            )}
          </li>
        )
      })}
    </ul>
  )
}
