import { useEffect, useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'
import { getSession } from '../auth/session'
import { api, providerIds, toolMeters, type Organization, type Preferences, type Usage } from '../lib/api'
import { useI18n, type Locale } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import MyDataSettings from './MyDataSettings'
import MemorySettings from './MemorySettings'
import { useBranding } from '../lib/branding'

// Réglages personnels (« Mon compte »). L'organisation se règle dans
// Administration (administrateurs), jamais ici.

type Props = {
  preferences: Preferences
  onPreferencesChange: (preferences: Preferences) => void
  /** Enregistrement attendu (refus du serveur affiché) : instructions personnalisées. */
  onPreferencesSave: (preferences: Preferences) => Promise<void>
  /** Conversations importées : la liste est relue. */
  onConversationsImported: () => void
}

const tokensOf = (totals?: { inputTokens: number; outputTokens: number }) =>
  (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0)

export function Meter({ label, used, limit }: { label: string; used: number; limit: number | null | undefined }) {
  const { t, formatNumber } = useI18n()
  const ratio = limit ? Math.min(1, used / limit) : 0
  return (
    <div className="settings-meter">
      <div className="settings-meter-label">
        <span>{label}</span>
        <span>
          {formatNumber(used)} / {limit ? formatNumber(limit) : t('settings.unlimited')}
        </span>
      </div>
      {limit ? (
        <div className="settings-meter-track" aria-hidden="true">
          <span className={ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warning' : ''} style={{ width: `${ratio * 100}%` }} />
        </div>
      ) : null}
    </div>
  )
}

/** Instructions personnalisées : enregistrées à la demande (elles partent avec chaque message). */
function InstructionsSettings({ value, onSave, saved }: { value: string; onSave: (value: string) => void; saved: boolean }) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? value
  return (
    <section className="settings-card" aria-label={t('instructions.title')}>
      <h3>{t('instructions.title')}</h3>
      <textarea
        className="settings-workshop-input"
        rows={4}
        maxLength={1500}
        value={text}
        placeholder={t('instructions.placeholder')}
        aria-label={t('instructions.title')}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="settings-hint">{t('instructions.hint')}</p>
      <button type="button" className="settings-save" disabled={draft === null || draft === value} onClick={() => onSave(text)}>
        <Check size={14} />
        {saved ? t('settings.saved') : t('common.save')}
      </button>
    </section>
  )
}

export default function SettingsPanel({ preferences, onPreferencesChange, onPreferencesSave, onConversationsImported }: Props) {
  const { t, locale, setLocale, formatNumber } = useI18n()
  const brand = useBranding()
  const session = getSession()
  const name = session.profile.name ?? session.profile.username ?? session.profile.email ?? ''

  const [usage, setUsage] = useState<Usage | null>(null)
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const fail = (cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause))

    api.getUsage().then((value) => !cancelled && setUsage(value)).catch(fail)
    api
      .getOrganization()
      .then((value) => !cancelled && setOrganization(value))
      .catch(fail)
    return () => {
      cancelled = true
    }
  }, [])

  function flash(key: string) {
    setSaved(key)
    setTimeout(() => setSaved((current) => (current === key ? null : current)), 1600)
  }

  async function run(key: string, action: () => Promise<void>) {
    setError('')
    try {
      await action()
      flash(key)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function updatePreferences(patch: Partial<Preferences>) {
    const next = { ...preferences, ...patch }
    onPreferencesChange(next)
    if (patch.locale) setLocale(patch.locale)
  }

  const monthly = usage?.limits.monthly ?? null

  return (
    <div className="settings-panel">
      <div className="sidebar-section-label">{t('settings.title').toUpperCase()}</div>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <section className="settings-card" aria-label={t('settings.profile')}>
        <div className="settings-profile">
          <div className="user-avatar">
            <img src={brand.logo} alt="" className="user-avatar-logo" />
          </div>
          <div>
            <strong>{name}</strong>
            {session.profile.email && <span>{session.profile.email}</span>}
          </div>
        </div>
        <div className="settings-tags">
          <span className="settings-tag">{t(`role.${session.user.role}`)}</span>
          {organization && <span className="settings-tag subtle">{organization.organization.name}</span>}
        </div>
        {session.accountUrl && (
          <a className="settings-link" href={session.accountUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={13} />
            {t('settings.account')}
          </a>
        )}
      </section>

      <section className="settings-card" aria-label={t('settings.preferences')}>
        <h3>{t('settings.preferences')}</h3>
        <div className="settings-row">
          <span>{t('settings.language')}</span>
          <div className="settings-segmented" role="radiogroup" aria-label={t('settings.language')}>
            {(['fr', 'en'] as Locale[]).map((code) => (
              <button
                key={code}
                type="button"
                role="radio"
                aria-checked={locale === code}
                onClick={() => updatePreferences({ locale: code })}
              >
                {code.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <label className="settings-row settings-switch">
          <span>
            {t('settings.sendOnEnter')}
            <small>{t('settings.sendOnEnterHint')}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={preferences.sendOnEnter}
            onChange={(event) => updatePreferences({ sendOnEnter: event.target.checked })}
          />
        </label>
        <div className="settings-row">
          <span>{t('settings.motion')}</span>
          <div className="settings-segmented" role="radiogroup" aria-label={t('settings.motion')}>
            {(['system', 'on'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={(preferences.reduceMotion === 'on') === (value === 'on')}
                onClick={() => updatePreferences({ reduceMotion: value })}
              >
                {t(`settings.motion.${value}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span>{t('settings.theme')}</span>
          <div className="settings-segmented" role="radiogroup" aria-label={t('settings.theme')}>
            {(['system', 'dark', 'light'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={preferences.theme === value} onClick={() => updatePreferences({ theme: value })}>
                {t(`settings.theme.${value}`)}
              </button>
            ))}
          </div>
        </div>
      </section>

      <InstructionsSettings
        value={preferences.instructions}
        onSave={(instructions) => run('instructions', async () => {
          await onPreferencesSave({ ...preferences, instructions })
        })}
        saved={saved === 'instructions'}
      />

      <MemorySettings enabled={preferences.memory} onToggle={(memory) => updatePreferences({ memory })} onError={setError} />

      <section className="settings-card" aria-label={t('settings.usage')}>
        <h3>{t('settings.usage')}</h3>
        {usage ? (
          <>
            <Meter label={t('settings.usageOrg')} used={tokensOf(usage.usage.total)} limit={monthly} />
            {providerIds
              .filter((id) => usage.usage.byProvider[id] || usage.limits.providers[id])
              .map((id) => (
                <Meter
                  key={id}
                  label={providerMeta[id].label}
                  used={tokensOf(usage.usage.byProvider[id])}
                  limit={usage.limits.providers[id]}
                />
              ))}
            {toolMeters
              .filter(({ id }) => usage.usage.tools?.[id] || usage.limits.tools?.[id])
              .map(({ id }) => (
                <Meter key={id} label={t(`settings.meter.${id}`)} used={usage.usage.tools?.[id] ?? 0} limit={usage.limits.tools?.[id]} />
              ))}
            <p className="settings-hint">
              {t('settings.usageMine')} : {t('settings.tokens', { count: formatNumber(tokensOf(usage.usage.mine)) })}
            </p>
          </>
        ) : (
          <p className="settings-hint">{t('common.loading')}</p>
        )}
      </section>

      <MyDataSettings onImported={onConversationsImported} onError={setError} />
    </div>
  )
}
