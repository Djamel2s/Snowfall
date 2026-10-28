import { useEffect, useState } from 'react'
import { ThumbsUp } from 'lucide-react'
import { adminPeriods, api, providerIds, toolMeters, type AdminOverview as Overview, type AdminPeriod } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import { Meter } from './SettingsPanel'

// Pilotage : ce que la direction veut savoir (adoption, agents utiles,
// consommation), en totaux de l'organisation. Aucune donnée par personne.

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/** Barres verticales simples (aucune bibliothèque) ; le détail est dans le titre de chaque barre. */
function Bars({ values, label, titles }: { values: number[]; label: string; titles: string[] }) {
  const max = Math.max(1, ...values)
  return (
    <div className="admin-bars" role="img" aria-label={label}>
      {values.map((value, index) => (
        <span key={index} title={titles[index]} style={{ height: `${Math.max(value ? 6 : 2, (value / max) * 100)}%` }} className={value ? '' : 'empty'} />
      ))}
    </div>
  )
}

export default function AdminOverview({ onError }: { onError: (message: string) => void }) {
  const { t, locale, formatNumber } = useI18n()
  const [days, setDays] = useState<AdminPeriod>(30)
  const [data, setData] = useState<Overview | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getAdminOverview(days)
      .then((value) => !cancelled && setData(value))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [days, onError])

  const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  const monthLabel = (period: string) => new Date(`${period}T00:00:00Z`).toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' })
  const monthTokens = (byProvider: Overview['tokens'][number]['byProvider']) => sum(Object.values(byProvider).map(Number))

  return (
    <>
      <div className="settings-row admin-period">
        <span>{t('admin.period')}</span>
        <div className="settings-segmented" role="radiogroup" aria-label={t('admin.period')}>
          {adminPeriods.map((value) => (
            <button key={value} type="button" role="radio" aria-checked={days === value} onClick={() => setDays(value)}>
              {t('admin.days', { count: value })}
            </button>
          ))}
        </div>
      </div>

      {!data || data.days !== days ? (
        <p className="settings-hint">{t('common.loading')}</p>
      ) : (
        <>
          <div className="admin-kpis">
            <section className="settings-card admin-kpi" aria-label={t('admin.active')}>
              <small>{t('admin.active')}</small>
              <strong>{formatNumber(data.members.activePeriod)}</strong>
              <span>{t('admin.activeOf', { total: formatNumber(data.members.total) })}</span>
              <span>{t('admin.active7', { count: formatNumber(data.members.active7) })}</span>
            </section>
            <section className="settings-card admin-kpi" aria-label={t('admin.messages')}>
              <small>{t('admin.messages')}</small>
              <strong>{formatNumber(sum(data.activity.map((day) => day.messages)))}</strong>
              <span>{t('admin.perDay', { count: formatNumber(Math.round(sum(data.activity.map((day) => day.messages)) / days)) })}</span>
            </section>
          </div>

          <section className="settings-card" aria-label={t('admin.activity')}>
            <h3>{t('admin.activity')}</h3>
            <Bars
              label={t('admin.activity')}
              values={data.activity.map((day) => day.messages)}
              titles={data.activity.map((day) => t('admin.activityDay', { day: dayLabel(day.day), messages: formatNumber(day.messages), users: formatNumber(day.users) }))}
            />
            {data.activity.length > 0 && (
              <div className="admin-axis">
                <span>{dayLabel(data.activity[0]!.day)}</span>
                <span>{dayLabel(data.activity.at(-1)!.day)}</span>
              </div>
            )}
          </section>

          <section className="settings-card" aria-label={t('admin.agents')}>
            <h3>{t('admin.agents')}</h3>
            {data.agents.length ? (
              <ul className="admin-agents">
                {data.agents.map((agent) => (
                  <li key={agent.agentId}>
                    <div>
                      <strong className={agent.name ? '' : 'muted'}>{agent.name ?? t('admin.agentHidden')}</strong>
                      <small>{t('admin.agentUsage', { messages: formatNumber(agent.messages), users: formatNumber(agent.users) })}</small>
                    </div>
                    {agent.rating && (
                      <span className="admin-rating">
                        <ThumbsUp size={12} />
                        {t('admin.useful', { rate: Math.round((agent.rating.up / agent.rating.total) * 100) })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="settings-hint">{t('admin.agentsEmpty')}</p>
            )}
          </section>

          <section className="settings-card" aria-label={t('admin.tokens')}>
            <h3>{t('admin.tokens')}</h3>
            <Meter label={t('admin.tokensMonth')} used={monthTokens(data.tokens.at(-1)?.byProvider ?? {})} limit={data.monthlyTokenLimit} />
            {providerIds
              .filter((id) => data.tokens.at(-1)?.byProvider[id])
              .map((id) => (
                <div key={id} className="admin-line">
                  <span>{providerMeta[id].label}</span>
                  <span>{formatNumber(data.tokens.at(-1)!.byProvider[id]!)}</span>
                </div>
              ))}
            <Bars
              label={t('admin.tokensMonths')}
              values={data.tokens.map((month) => monthTokens(month.byProvider))}
              titles={data.tokens.map((month) => `${monthLabel(month.period)} : ${t('settings.tokens', { count: formatNumber(monthTokens(month.byProvider)) })}`)}
            />
            <div className="admin-axis">
              {data.tokens.map((month) => (
                <span key={month.period}>{monthLabel(month.period)}</span>
              ))}
            </div>
          </section>

          {toolMeters.some(({ id }) => data.tools[id]) && (
            <section className="settings-card" aria-label={t('admin.tools')}>
              <h3>{t('admin.tools')}</h3>
              {toolMeters
                .filter(({ id }) => data.tools[id])
                .map(({ id }) => (
                  <div key={id} className="admin-line">
                    <span>{t(`settings.meter.${id}`)}</span>
                    <span>{formatNumber(data.tools[id]!)}</span>
                  </div>
                ))}
            </section>
          )}

          <p className="settings-hint">{t('admin.privacy')}</p>
        </>
      )}
    </>
  )
}
