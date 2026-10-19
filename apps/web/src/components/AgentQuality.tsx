import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, History, Plus, Sparkles, Square, X } from 'lucide-react'
import { api, type AgentEvalCase, type AgentVersion, type ImproveProgress, type ImproveResult } from '../lib/api'
import { formatDate, useI18n } from '../lib/i18n'

type Props = {
  agentId: string
  /** Instructions enregistrées ; modifiées sans enregistrer : on ne mesure pas. */
  instructions: string
  dirty: boolean
  /** Nouvelle version appliquée (amélioration ou restauration). */
  onApplied: (instructions: string) => void
}

const fraction = (score: { passed: number; total: number }) => `${score.passed}/${score.total}`

/**
 * Qualité d'un agent (auteur ou administrateur) : cas de test, amélioration
 * mesurée, versions. Rien n'est appliqué sans un clic, et seulement une
 * proposition meilleure, sans régression.
 */
export default function AgentQuality({ agentId, instructions, dirty, onApplied }: Props) {
  const { t, locale } = useI18n()
  const [cases, setCases] = useState<AgentEvalCase[]>([])
  const [versions, setVersions] = useState<AgentVersion[]>([])
  const [rubrics, setRubrics] = useState<Record<string, string>>({})
  const [question, setQuestion] = useState('')
  const [rubric, setRubric] = useState('')
  const [progress, setProgress] = useState<ImproveProgress | null>(null)
  const [result, setResult] = useState<ImproveResult | null>(null)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)

  async function reload() {
    const quality = await api.getQuality(agentId)
    setCases(quality.cases)
    setVersions(quality.versions)
  }

  useEffect(() => {
    let cancelled = false
    api
      .getQuality(agentId)
      .then((quality) => {
        if (cancelled) return
        setCases(quality.cases)
        setVersions(quality.versions)
      })
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
      controller.current?.abort()
    }
  }, [agentId])

  async function run(action: () => Promise<void>) {
    setError('')
    try {
      await action()
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // Champs dans le formulaire du studio : Entrée ne doit pas l'enregistrer.
  const stay = (event: KeyboardEvent) => event.key === 'Enter' && event.preventDefault()

  async function improve() {
    const abort = new AbortController()
    controller.current = abort
    setResult(null)
    setProgress({ phase: 'before', done: 0, total: active.length })
    await run(async () => {
      setResult(await api.improveAgent(agentId, setProgress, abort.signal))
      await reload()
    })
    setProgress(null)
    controller.current = null
  }

  const active = cases.filter((item) => item.status === 'active')
  const current = versions[0]
  const blocked = dirty ? t('quality.saveFirst') : active.length < 2 ? t('quality.needCases') : ''

  return (
    <section className="studio-quality" aria-label={t('quality.title')}>
      <div className="studio-quality-head">
        <span className="studio-parameters-label">{t('quality.title')}</span>
        {current?.score && <span className="studio-quality-score">{fraction(current.score)}</span>}
      </div>

      <ul className="studio-quality-cases">
        {cases.map((item) => (
          <li key={item.id} className={item.status}>
            <span className="studio-quality-question">{item.question}</span>
            {item.status === 'proposed' ? (
              <>
                {item.comment && <small>« {item.comment} »</small>}
                <small className="studio-quality-origin">{t('quality.proposed')}</small>
                <span className="studio-quality-row">
                  <input
                    value={rubrics[item.id] ?? ''}
                    maxLength={500}
                    placeholder={t('quality.rubric')}
                    aria-label={t('quality.rubric')}
                    onKeyDown={stay}
                    onChange={(event) => setRubrics({ ...rubrics, [item.id]: event.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={t('quality.validate')}
                    title={t('quality.validate')}
                    disabled={(rubrics[item.id] ?? '').trim().length < 5}
                    onClick={() => void run(async () => {
                      const updated = await api.activateEvalCase(agentId, item.id, rubrics[item.id]!.trim())
                      setCases((list) => list.map((entry) => (entry.id === item.id ? updated : entry)))
                    })}
                  >
                    <Check size={13} />
                  </button>
                </span>
              </>
            ) : (
              <small>{item.rubric}</small>
            )}
            <button
              type="button"
              className="studio-quality-remove"
              aria-label={t('common.delete')}
              title={t('common.delete')}
              onClick={() => void run(async () => {
                await api.deleteEvalCase(agentId, item.id)
                setCases((list) => list.filter((entry) => entry.id !== item.id))
              })}
            >
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>

      <div className="studio-quality-new">
        <input value={question} maxLength={2000} placeholder={t('quality.question')} aria-label={t('quality.question')} onKeyDown={stay} onChange={(event) => setQuestion(event.target.value)} />
        <span className="studio-quality-row">
          <input value={rubric} maxLength={500} placeholder={t('quality.rubric')} aria-label={`${t('quality.rubric')} (${t('quality.add')})`} onKeyDown={stay} onChange={(event) => setRubric(event.target.value)} />
          <button
            type="button"
            aria-label={t('quality.add')}
            title={t('quality.add')}
            disabled={question.trim().length < 3 || rubric.trim().length < 5}
            onClick={() => void run(async () => {
              const created = await api.addEvalCase(agentId, question.trim(), rubric.trim())
              setCases((list) => [created, ...list])
              setQuestion('')
              setRubric('')
            })}
          >
            <Plus size={13} />
          </button>
        </span>
      </div>

      {progress ? (
        <div className="studio-quality-progress" role="status">
          <span>{t(`quality.phase.${progress.phase}`, { done: progress.done, total: progress.total })}</span>
          <button type="button" onClick={() => controller.current?.abort()}>
            <Square size={11} />
            {t('quality.stop')}
          </button>
        </div>
      ) : (
        <button type="button" className="studio-quality-improve" disabled={Boolean(blocked)} title={blocked} onClick={() => void improve()}>
          <Sparkles size={14} />
          {t('quality.improve')}
        </button>
      )}
      {blocked && !progress && <small className="studio-quality-hint">{blocked}</small>}

      {result && (
        <div className={`studio-quality-result ${result.kind}`} role="status">
          <strong>
            {fraction(result.before.score)}
            {result.after && ` → ${fraction(result.after.score)}`}
          </strong>
          {result.kind === 'nothing_to_fix' && <span>{t('quality.nothing')}</span>}
          {result.kind === 'no_proposal' && <span>{t('quality.noProposal')}</span>}
          {result.kind === 'rejected' && <span>{t('quality.rejected')}</span>}
          {result.heldOut && <small>{t('quality.heldOut', { before: fraction(result.heldOut.before), after: fraction(result.heldOut.after) })}</small>}
          <small>{t('quality.judge', { model: result.judge })}</small>
          {result.kind === 'proposed' && result.instructions && result.proposalId && (
            <>
              <pre className="studio-quality-proposal">{result.instructions}</pre>
              <span className="studio-quality-row">
                <button
                  type="button"
                  className="studio-quality-apply"
                  onClick={() => void run(async () => {
                    const applied = await api.applyProposal(agentId, result.proposalId!)
                    onApplied(applied.agent.instructions)
                    setResult(null)
                    await reload()
                  })}
                >
                  <Check size={13} />
                  {t('quality.apply')}
                </button>
                <button type="button" onClick={() => setResult(null)}>
                  {t('quality.dismiss')}
                </button>
              </span>
            </>
          )}
        </div>
      )}

      {versions.length > 0 && (
        <details className="studio-quality-versions">
          <summary>
            <History size={13} />
            {t('quality.versions')}
          </summary>
          <ul>
            {versions.map((version) => (
              <li key={version.id}>
                <span>
                  v{version.version} · {t(`quality.source.${version.source}`)} · {formatDate(version.createdAt, locale)}
                </span>
                {version.score && <span className="studio-quality-score">{fraction(version.score)}</span>}
                {version.instructions !== instructions && (
                  <button
                    type="button"
                    disabled={dirty}
                    title={dirty ? t('quality.saveFirst') : version.instructions.slice(0, 300)}
                    onClick={() => void run(async () => {
                      const applied = await api.restoreVersion(agentId, version.id)
                      onApplied(applied.agent.instructions)
                      await reload()
                    })}
                  >
                    {t('quality.restore')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && <p className="studio-error" role="alert">{error}</p>}
    </section>
  )
}
