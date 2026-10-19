import { useState } from 'react'
import { Check, FlaskConical, Plus, RotateCcw, X } from 'lucide-react'
import { api, type Confusion, type Workshop } from '../lib/api'
import { useI18n } from '../lib/i18n'

const right = (c: Confusion) => `${c.tp + c.tn}/${c.tp + c.fn + c.tn + c.fp}`
const recall = (c: Confusion) => `${c.tp}/${c.tp + c.fn}`

/**
 * Atelier (administrateurs) : exemples étiquetés écrits à la main, entraînement
 * local du décideur de routage, mesure sur la part de test, déploiement seulement
 * d'un modèle meilleur que la référence. Replié par défaut ; chargé à l'ouverture.
 */
export default function DecisionWorkshop({ onError }: { onError: (message: string) => void }) {
  const { t } = useI18n()
  const [workshop, setWorkshop] = useState<Workshop | null>(null)
  const [text, setText] = useState('')
  const [label, setLabel] = useState('simple')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const reload = async () => setWorkshop(await api.getWorkshop())

  const examples = workshop?.examples ?? []
  const labels = workshop?.labels ?? { positive: 'complexe', negative: 'simple' }
  const count = (value: string) => examples.filter((item) => item.label === value).length
  const active = workshop?.models.find((model) => model.status === 'active')
  const latest = workshop?.models[0]

  return (
    <details className="settings-workshop" onToggle={(event) => (event.currentTarget.open && !workshop ? void run(reload) : undefined)}>
      <summary>
        <FlaskConical size={13} />
        {t('workshop.title')}
      </summary>
      {workshop && !workshop.available && <p className="settings-hint">{t('workshop.unavailable')}</p>}
      {workshop && (
        <>
          <div className="settings-row">
            <span>{active ? t('workshop.trained', { version: active.version }) : t('workshop.base')}</span>
            {active && (
              <button type="button" className="settings-link" disabled={busy} onClick={() => void run(async () => { await api.deactivateDecision(); await reload() })}>
                <RotateCcw size={12} />
                {t('workshop.reset')}
              </button>
            )}
          </div>
          <p className="settings-hint">{t('workshop.hint')}</p>
          <textarea className="settings-workshop-input" rows={3} maxLength={20_000} value={text} placeholder={t('workshop.examples')} aria-label={t('workshop.examples')} onChange={(event) => setText(event.target.value)} />
          <div className="settings-row">
            <div className="settings-segmented" role="radiogroup" aria-label={t('workshop.examples')}>
              {[labels.negative, labels.positive].map((value) => (
                <button key={value} type="button" role="radio" aria-checked={label === value} onClick={() => setLabel(value)}>
                  {t(`workshop.label.${value}` as 'workshop.label.simple')}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="settings-save"
              disabled={busy || !text.trim()}
              onClick={() => void run(async () => {
                const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length >= 2).slice(0, 100)
                await api.addDecisionExamples(lines.map((line) => ({ text: line, label })))
                setText('')
                await reload()
              })}
            >
              <Plus size={13} />
              {t('workshop.add')}
            </button>
          </div>
          <p className="settings-hint">
            {t('workshop.counts', { negative: count(labels.negative), simple: t('workshop.label.simple'), positive: count(labels.positive), complex: t('workshop.label.complexe'), test: examples.filter((item) => item.split === 'test').length })}
          </p>
          {examples.length > 0 && (
            <ul className="settings-workshop-examples">
              {examples.map((item) => (
                <li key={item.id}>
                  <span className={`settings-tag ${item.label === labels.positive ? '' : 'subtle'}`}>{t(`workshop.label.${item.label}` as 'workshop.label.simple')}</span>
                  <span className="settings-workshop-text">{item.text}</span>
                  {item.split === 'test' && <small>{t('workshop.test')}</small>}
                  <button type="button" aria-label={t('common.delete')} title={t('common.delete')} disabled={busy} onClick={() => void run(async () => { await api.deleteDecisionExample(item.id); await reload() })}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {workshop.available && (
            <button type="button" className="settings-save" disabled={busy} onClick={() => void run(async () => { await api.trainDecision(); await reload() })}>
              <FlaskConical size={13} />
              {t('workshop.train')}
            </button>
          )}
          {latest && latest.status === 'candidate' && (
            <div className="settings-workshop-result" role="status">
              <span>
                {t('workshop.result', { baseline: right(latest.metrics.baseline), candidate: right(latest.metrics.candidate), recallBase: recall(latest.metrics.baseline), recallCandidate: recall(latest.metrics.candidate) })}
              </span>
              {latest.deployable ? (
                <button type="button" className="settings-save" disabled={busy} onClick={() => void run(async () => { await api.activateDecision(latest.id); await reload() })}>
                  <Check size={13} />
                  {t('workshop.deploy')}
                </button>
              ) : (
                <small>{t('workshop.notDeployable')}</small>
              )}
            </div>
          )}
        </>
      )}
    </details>
  )
}
