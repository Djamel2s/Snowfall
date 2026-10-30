import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Download, ShieldAlert } from 'lucide-react'
import { api, type AuditCursor, type AuditEntry, type AuditFilter } from '../lib/api'
import { useI18n } from '../lib/i18n'

/** Familles d'événements (préfixe du type), pour filtrer le journal. */
const CATEGORIES = [
  { id: 'auth', prefixes: ['auth'] },
  { id: 'security', prefixes: ['security', 'quota'] },
  { id: 'admin', prefixes: ['organization', 'branding', 'admin'] },
  { id: 'agents', prefixes: ['agent', 'skill', 'prompt', 'decision'] },
  { id: 'data', prefixes: ['conversation', 'message', 'knowledge', 'attachment', 'privacy', 'memory', 'project'] },
  { id: 'sharing', prefixes: ['share'] },
  { id: 'connectors', prefixes: ['mcp', 'tool'] },
] as const
type Category = (typeof CATEGORIES)[number]['id']

/**
 * Administration › Sécurité : durée de conservation des conversations, journal
 * d'audit de l'organisation (filtres, pages, export CSV), et le rappel des
 * droits des personnes (chacun exporte ses données depuis « Mon compte »).
 */
export default function SecuritySettings({ onError }: { onError: (message: string) => void }) {
  const { t, locale } = useI18n()
  const [retention, setRetention] = useState<{ conversationDays: number | null; choices: number[] } | null>(null)
  const [saved, setSaved] = useState(false)
  const [category, setCategory] = useState<Category | null>(null)
  const [problems, setProblems] = useState(false)
  const [events, setEvents] = useState<AuditEntry[]>([])
  const [next, setNext] = useState<AuditCursor | null>(null)
  // Filtres de la page affichée : différents des filtres choisis, c'est qu'elle se charge.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const filter: AuditFilter = { categories: category ? [...CATEGORIES.find((item) => item.id === category)!.prefixes] : [], problems }
  const fail = useCallback((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)), [onError])

  useEffect(() => {
    api.getRetention().then(setRetention).catch(fail)
  }, [fail])

  const key = `${category ?? ''}|${problems}`
  const loading = loadedKey !== key || loadingMore

  useEffect(() => {
    let cancelled = false
    api
      .listAudit({ categories: category ? [...CATEGORIES.find((item) => item.id === category)!.prefixes] : [], problems })
      .then((page) => {
        if (cancelled) return
        setEvents(page.events)
        setNext(page.next)
        setLoadedKey(`${category ?? ''}|${problems}`)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        fail(cause)
        setLoadedKey(`${category ?? ''}|${problems}`)
      })
    return () => {
      cancelled = true
    }
  }, [category, problems, fail])

  async function more() {
    if (!next) return
    setLoadingMore(true)
    try {
      const page = await api.listAudit(filter, next)
      setEvents((current) => [...current, ...page.events])
      setNext(page.next)
    } catch (cause) {
      fail(cause)
    } finally {
      setLoadingMore(false)
    }
  }

  async function exportCsv() {
    try {
      const url = URL.createObjectURL(await api.exportAudit(filter))
      const link = document.createElement('a')
      link.href = url
      link.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (cause) {
      fail(cause)
    }
  }

  async function saveRetention(value: string) {
    const conversationDays = value === '' ? null : Number(value)
    try {
      const result = await api.setRetention(conversationDays)
      setRetention((current) => (current ? { ...current, conversationDays: result.conversationDays } : current))
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (cause) {
      fail(cause)
    }
  }

  const when = (iso: string) => new Date(iso).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

  return (
    <>
      <section className="settings-card" aria-label={t('security.retention')}>
        <h3>{t('security.retention')}</h3>
        <label className="settings-field">
          <span>{t('security.retentionLabel')}</span>
          <select value={retention?.conversationDays ?? ''} disabled={!retention} onChange={(event) => void saveRetention(event.target.value)}>
            <option value="">{t('security.retentionNone')}</option>
            {(retention?.choices ?? []).map((days) => (
              <option key={days} value={days}>
                {days % 365 === 0 ? t('security.years', { count: days / 365 }) : t('security.days', { count: days })}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          {saved && <Check size={11} />} {retention?.conversationDays ? t('security.retentionOn', { count: retention.conversationDays }) : t('security.retentionOff')}
        </p>
      </section>

      <section className="settings-card" aria-label={t('security.audit')}>
        <div className="security-audit-head">
          <h3>{t('security.audit')}</h3>
          <button type="button" className="settings-secondary" onClick={() => void exportCsv()}>
            <Download size={13} />
            {t('security.export')}
          </button>
        </div>
        <div className="sidebar-tags" role="group" aria-label={t('security.categories')}>
          <button type="button" className="sidebar-tag" aria-pressed={category === null} onClick={() => setCategory(null)}>
            {t('security.category.all')}
          </button>
          {CATEGORIES.map((item) => (
            <button key={item.id} type="button" className="sidebar-tag" aria-pressed={category === item.id} onClick={() => setCategory(category === item.id ? null : item.id)}>
              {t(`security.category.${item.id}`)}
            </button>
          ))}
        </div>
        <label className="settings-row settings-switch">
          <span>{t('security.problems')}</span>
          <input type="checkbox" role="switch" checked={problems} onChange={(event) => setProblems(event.target.checked)} />
        </label>

        {events.length === 0 && !loading ? (
          <p className="settings-hint">{t('security.empty')}</p>
        ) : (
          <ul className="audit-list" aria-label={t('security.audit')}>
            {events.map((entry) => (
              <li key={entry.id} className={entry.outcome === 'success' ? '' : 'audit-problem'}>
                <button type="button" aria-expanded={open === entry.id} onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                  {open === entry.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="audit-main">
                    <code>{entry.eventType}</code>
                    <small>
                      {when(entry.occurredAt)} · {entry.actorEmail ?? t('security.system')}
                    </small>
                  </span>
                  {entry.outcome !== 'success' && (
                    <span className={`list-row-chip ${entry.outcome === 'denied' ? 'warn' : 'muted'}`}>
                      <ShieldAlert size={9} /> {t(`security.outcome.${entry.outcome}`)}
                    </span>
                  )}
                </button>
                {open === entry.id && (
                  <dl className="audit-details">
                    {entry.targetType && (
                      <>
                        <dt>{t('security.target')}</dt>
                        <dd>
                          {entry.targetType} {entry.targetId}
                        </dd>
                      </>
                    )}
                    {entry.ip && (
                      <>
                        <dt>IP</dt>
                        <dd>{entry.ip}</dd>
                      </>
                    )}
                    {Object.entries(entry.details).map(([key, value]) => (
                      <div key={key} className="audit-detail">
                        <dt>{key}</dt>
                        <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        )}
        {loading && <p className="settings-hint">{t('common.loading')}</p>}
        {next && !loading && (
          <button type="button" className="settings-secondary" onClick={() => void more()}>
            {t('security.more')}
          </button>
        )}
        <p className="settings-hint">{t('security.auditHint')}</p>
      </section>

      <section className="settings-card" aria-label={t('security.rights')}>
        <h3>{t('security.rights')}</h3>
        <p className="settings-hint">{t('security.rightsHint')}</p>
      </section>
    </>
  )
}
