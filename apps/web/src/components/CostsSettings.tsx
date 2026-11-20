import { useEffect, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { api, providerIds, toolMeters, type OrganizationCosts, type OrganizationSettings, type ProviderId, type TokenPrice } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import { Meter } from './SettingsPanel'

// Coûts et limites (administration) : ce que l'organisation dépense ce mois-ci,
// les tarifs qui le calculent, les budgets et les plafonds. Les tarifs sont
// saisis ici : aucun prix intégré (ceux des fournisseurs changent souvent).

type Props = {
  draft: OrganizationSettings
  setDraft: (next: OrganizationSettings) => void
  platformTools: readonly string[]
  onSave: () => void
  saved: boolean
  onError: (message: string) => void
}

/** Saisie d'un nombre (virgule acceptée) ; vide ou invalide : null. */
function amountValue(value: string, { integer = false, min = 0 } = {}) {
  const text = value.replace(/\s/g, '').replace(',', '.')
  if (!text) return null
  const number = Number(text)
  if (!Number.isFinite(number) || number < min) return null
  return integer ? Math.floor(number) : number
}

const external = (id: ProviderId) => id !== 'local'

/**
 * Montant saisi librement (virgule, effacement) puis validé en quittant le
 * champ : le texte reste celui tapé, même si l'enregistrement change la valeur
 * d'un champ voisin entre-temps.
 */
function AmountInput({ value, onCommit, label, placeholder, min }: { value: number | null | undefined; onCommit: (value: number | null) => void; label?: string; placeholder: string; min?: number }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <input
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder}
      value={text ?? (value === null || value === undefined ? '' : String(value))}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text === null) return
        onCommit(amountValue(text, { min: min ?? 0 }))
        setText(null)
      }}
    />
  )
}

export default function CostsSettings({ draft, setDraft, platformTools, onSave, saved, onError }: Props) {
  const { t, locale, formatNumber } = useI18n()
  const [costs, setCosts] = useState<OrganizationCosts | null>(null)
  const euro = (value: number) => new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: value && value < 1 ? 4 : 2 }).format(value)

  useEffect(() => {
    let cancelled = false
    api
      .getOrganizationCosts()
      .then((value) => !cancelled && setCosts(value))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [onError])

  const prices = draft.prices ?? { models: {}, tools: {} }
  const setPrice = (key: string, field: keyof TokenPrice, value: number | null) => {
    const models = { ...prices.models }
    const current = models[key] ?? { input: 0, output: 0 }
    const next = { ...current, [field]: value ?? 0 }
    if (value === null && !models[key]) return
    if (next.input === 0 && next.output === 0 && value === null) delete models[key]
    else models[key] = next
    setDraft({ ...draft, prices: { ...prices, models } })
  }
  const setToolPrice = (meter: string, value: number | null) => {
    const tools = { ...prices.tools }
    if (value === null) delete tools[meter as keyof typeof tools]
    else tools[meter as keyof typeof tools] = value
    setDraft({ ...draft, prices: { ...prices, tools } })
  }
  const setLimit = (field: 'toolLimits' | 'memberToolLimits', meter: string, value: number | null) => {
    const limits = { ...(draft[field] ?? {}) }
    if (value === null) delete limits[meter as keyof typeof limits]
    else limits[meter as keyof typeof limits] = value
    setDraft({ ...draft, [field]: limits })
  }

  const priceInputs = (key: string, label: string) => (
    <div className="costs-price" key={key}>
      {(['input', 'output'] as const).map((field) => (
        <label key={field}>
          <span>{t(field === 'input' ? 'costs.input' : 'costs.output')}</span>
          <AmountInput
            label={`${label} · ${t(field === 'input' ? 'costs.input' : 'costs.output')}`}
            placeholder="—"
            value={prices.models[key]?.[field]}
            onCommit={(value) => setPrice(key, field, value)}
          />
        </label>
      ))}
    </div>
  )

  const meters = toolMeters.filter(({ tool }) => platformTools.includes(tool))
  const providers = providerIds.filter((id) => external(id) && draft.allowedProviders.includes(id))
  const used = new Set((costs?.models ?? []).map((row) => `${row.provider}:${row.model || '*'}`))

  return (
    <>
      <section className="settings-card" aria-label={t('costs.month')}>
        <h3>{t('costs.month')}</h3>
        {costs ? (
          <>
            <Meter label={t('costs.spent')} used={costs.total} limit={draft.monthlyBudget ?? null} format={euro} />
            {costs.unpriced.length > 0 && (
              <p className="costs-warning" role="status">
                <TriangleAlert size={12} />
                {t(costs.unpriced.length === 1 ? 'costs.unpriced.one' : 'costs.unpriced.many', { count: costs.unpriced.length })}
              </p>
            )}
            {costs.models.map((row) => {
              const key = `${row.provider}:${row.model || '*'}`
              const label = `${providerMeta[row.provider].label} · ${row.model || t('costs.unknownModel')}`
              return (
                <div key={key} className="costs-row">
                  <div className="admin-line">
                    <span>{label}</span>
                    <span className={row.euros === null ? 'costs-missing' : ''}>{row.euros === null ? t('costs.noPrice') : euro(row.euros)}</span>
                  </div>
                  <small>{t('costs.tokens', { input: formatNumber(row.inputTokens), output: formatNumber(row.outputTokens) })}</small>
                  {row.provider !== 'local' && row.model && priceInputs(key, label)}
                </div>
              )
            })}
            {costs.tools.map((row) => (
              <div key={row.meter} className="admin-line">
                <span>{t('costs.toolCalls', { tool: t(`settings.meter.${row.meter}`), count: formatNumber(row.calls) })}</span>
                <span>{euro(row.euros)}</span>
              </div>
            ))}
            {!costs.models.length && !costs.tools.length && <p className="settings-hint">{t('costs.nothing')}</p>}
          </>
        ) : (
          <p className="settings-hint">{t('common.loading')}</p>
        )}
      </section>

      <section className="settings-card" aria-label={t('costs.prices')}>
        <h3>{t('costs.prices')}</h3>
        <p className="settings-hint">{t('costs.pricesHint')}</p>
        {providers.map((id) => {
          const key = `${id}:*`
          const label = t('costs.providerDefault', { provider: providerMeta[id].label })
          return (
            <div key={key} className="costs-row">
              <span className="costs-label">{label}</span>
              {priceInputs(key, label)}
            </div>
          )
        })}
        {Object.keys(prices.models)
          .filter((key) => !key.endsWith(':*') && !used.has(key))
          .map((key) => (
            <div key={key} className="costs-row">
              <span className="costs-label">{key}</span>
              {priceInputs(key, key)}
            </div>
          ))}
        {meters.map(({ id }) => (
          <label key={id} className="settings-field">
            <span>{t('costs.toolPrice', { tool: t(`settings.meter.${id}`) })}</span>
            <AmountInput placeholder="0" value={prices.tools[id]} onCommit={(value) => setToolPrice(id, value)} />
          </label>
        ))}
      </section>

      <section className="settings-card" aria-label={t('costs.budgets')}>
        <h3>{t('costs.budgets')}</h3>
        {(['monthlyBudget', 'memberMonthlyBudget'] as const).map((field) => (
          <label key={field} className="settings-field">
            <span>{t(field === 'monthlyBudget' ? 'costs.budgetOrg' : 'costs.budgetMember')}</span>
            <AmountInput placeholder={t('settings.quotaPlaceholder')} value={draft[field]} min={0.01} onCommit={(value) => setDraft({ ...draft, [field]: value })} />
          </label>
        ))}
        <p className="settings-hint">{t('costs.budgetsHint')}</p>
      </section>

      <section className="settings-card" aria-label={t('settings.quotas')}>
        <h3>{t('settings.quotas')}</h3>
        <label className="settings-field">
          <span>{t('settings.quotaOrg')}</span>
          <input
            inputMode="numeric"
            placeholder={t('settings.quotaPlaceholder')}
            value={draft.monthlyTokenLimit ?? ''}
            onChange={(event) => setDraft({ ...draft, monthlyTokenLimit: amountValue(event.target.value, { integer: true, min: 1 }) })}
          />
        </label>
        {draft.allowedProviders.map((id) => (
          <label key={id} className="settings-field">
            <span>{t('settings.quotaProvider', { provider: providerMeta[id].label })}</span>
            <input
              inputMode="numeric"
              placeholder={t('settings.quotaPlaceholder')}
              value={draft.providerTokenLimits[id] ?? ''}
              onChange={(event) => {
                const limits = { ...draft.providerTokenLimits }
                const value = amountValue(event.target.value, { integer: true, min: 1 })
                if (value === null) delete limits[id]
                else limits[id] = value
                setDraft({ ...draft, providerTokenLimits: limits })
              }}
            />
          </label>
        ))}
        {meters.map(({ id }) => (
          <div key={id} className="costs-pair">
            {(['toolLimits', 'memberToolLimits'] as const).map((field) => (
              <label key={field} className="settings-field">
                <span>{t(field === 'toolLimits' ? 'settings.quotaTool' : 'costs.quotaToolMember', { tool: t(`settings.meter.${id}`) })}</span>
                <input
                  inputMode="numeric"
                  placeholder={t('settings.quotaPlaceholder')}
                  value={draft[field]?.[id] ?? ''}
                  onChange={(event) => setLimit(field, id, amountValue(event.target.value, { integer: true, min: 1 }))}
                />
              </label>
            ))}
          </div>
        ))}
      </section>

      <section className="settings-card" aria-label={t('costs.response')}>
        <h3>{t('costs.response')}</h3>
        <div className="costs-pair">
          <label className="settings-field">
            <span>{t('costs.responseTokens')}</span>
            <input
              inputMode="numeric"
              placeholder={t('costs.platform')}
              value={draft.responseMaxTokens ?? ''}
              onChange={(event) => setDraft({ ...draft, responseMaxTokens: amountValue(event.target.value, { integer: true, min: 1 }) })}
            />
          </label>
          <label className="settings-field">
            <span>{t('costs.responseSeconds')}</span>
            <input
              inputMode="numeric"
              placeholder={t('costs.platform')}
              value={draft.responseMaxSeconds ?? ''}
              onChange={(event) => setDraft({ ...draft, responseMaxSeconds: amountValue(event.target.value, { integer: true, min: 1 }) })}
            />
          </label>
        </div>
        <p className="settings-hint">{t('costs.responseHint')}</p>
      </section>

      <button type="button" className="settings-save" onClick={onSave}>
        <Check size={14} />
        {saved ? t('settings.saved') : t('common.save')}
      </button>
    </>
  )
}
