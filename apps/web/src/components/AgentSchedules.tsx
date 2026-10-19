import { useEffect, useState } from 'react'
import { AlarmClock, Play, Trash2 } from 'lucide-react'
import { api, type Agent, type AgentSchedule } from '../lib/api'
import { formatDate, useI18n } from '../lib/i18n'
import { AgentAvatar } from './AgentAvatar'

type Props = {
  agents: Agent[]
  /** Agent choisi pour une nouvelle tâche (formulaire ouvert). */
  scheduling: Agent | null
  onCloseForm: () => void
  onOpen: (conversationId: string) => void
  onError: (message: string) => void
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris'

/**
 * Tâches de l'utilisateur : une consigne envoyée à un agent chaque jour, chaque
 * semaine, ou quand un document arrive dans sa base. Le résultat s'écrit dans une
 * conversation dédiée ; une écriture y attend sa validation.
 */
export default function AgentSchedules({ agents, scheduling, onCloseForm, onOpen, onError }: Props) {
  const { t, locale } = useI18n()
  const [schedules, setSchedules] = useState<AgentSchedule[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<'daily' | 'weekly' | 'knowledge'>('weekly')
  const [hour, setHour] = useState(9)
  const [weekday, setWeekday] = useState(1)

  useEffect(() => {
    let cancelled = false
    api.listSchedules().then((list) => !cancelled && setSchedules(list)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  async function run(action: () => Promise<void>) {
    try {
      await action()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const replace = (next: AgentSchedule) => setSchedules((list) => list.map((item) => (item.id === next.id ? next : item)))
  const day = (value: number) => new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(Date.UTC(2026, 9, 18 + value)))
  const when = (schedule: AgentSchedule) =>
    schedule.kind === 'knowledge'
      ? t('schedules.onDocument')
      : schedule.enabled && schedule.nextRunAt
        ? t('schedules.next', { date: formatDate(schedule.nextRunAt, locale) })
        : t('schedules.disabled')
  const canTrigger = Boolean(scheduling?.tools.includes('search_knowledge'))

  if (!scheduling && schedules.length === 0) return null

  return (
    <section className="agent-schedules" aria-label={t('schedules.title')}>
      {schedules.length > 0 && (
        <>
          <div className="sidebar-section-label">{t('schedules.title').toUpperCase()}</div>
          <ul>
            {schedules.map((schedule) => {
              const agent = agents.find((item) => item.id === schedule.agentId)
              return (
                <li key={schedule.id} className={schedule.enabled ? '' : 'off'}>
                  {agent && <AgentAvatar avatar={agent.avatar} size={26} />}
                  <button type="button" className="agent-schedule-main" title={t('schedules.open')} onClick={() => onOpen(schedule.conversationId)}>
                    <strong>{schedule.name}</strong>
                    <small>
                      {when(schedule)}
                      {schedule.lastStatus && ` · ${t(`schedules.status.${schedule.lastStatus}`)}`}
                    </small>
                  </button>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`${t('schedules.toggle')} : ${schedule.name}`}
                    checked={schedule.enabled}
                    onChange={(event) => void run(async () => replace(await api.setScheduleEnabled(schedule.id, event.target.checked)))}
                  />
                  <button type="button" aria-label={`${t('schedules.runNow')} : ${schedule.name}`} title={t('schedules.runNow')} disabled={!schedule.enabled} onClick={() => void run(() => api.runSchedule(schedule.id).then(() => undefined))}>
                    <Play size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('common.delete')} : ${schedule.name}`}
                    title={t('common.delete')}
                    onClick={() => void run(async () => {
                      await api.deleteSchedule(schedule.id)
                      setSchedules((list) => list.filter((item) => item.id !== schedule.id))
                    })}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {scheduling && (
        <form
          className="agent-schedule-form"
          aria-label={t('schedules.new', { name: scheduling.name })}
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const created = await api.createSchedule({
                agentId: scheduling.id,
                name: name.trim() || scheduling.name,
                prompt: prompt.trim(),
                timezone: timezone(),
                ...(kind === 'knowledge' ? { kind: 'knowledge' as const } : { kind: 'schedule' as const, cadence: kind, hour, ...(kind === 'weekly' ? { weekday } : {}) }),
              })
              setSchedules((list) => [...list, created])
              setName('')
              setPrompt('')
              onCloseForm()
            })
          }}
        >
          <div className="agent-schedule-head">
            <AgentAvatar avatar={scheduling.avatar} size={26} />
            <strong>{t('schedules.new', { name: scheduling.name })}</strong>
          </div>
          <input value={name} maxLength={60} placeholder={t('schedules.name')} aria-label={t('schedules.name')} onChange={(event) => setName(event.target.value)} />
          <textarea value={prompt} rows={3} maxLength={4000} placeholder={t('schedules.prompt')} aria-label={t('schedules.prompt')} onChange={(event) => setPrompt(event.target.value)} />
          <div className="settings-segmented" role="radiogroup" aria-label={t('schedules.when')}>
            {(['daily', 'weekly', ...(canTrigger ? ['knowledge' as const] : [])] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => setKind(value)}>
                {t(`schedules.${value}`)}
              </button>
            ))}
          </div>
          {kind !== 'knowledge' && (
            <div className="agent-schedule-row">
              {kind === 'weekly' && (
                <select value={weekday} aria-label={t('schedules.weekday')} onChange={(event) => setWeekday(Number(event.target.value))}>
                  {WEEKDAYS.map((value) => (
                    <option key={value} value={value}>
                      {day(value)}
                    </option>
                  ))}
                </select>
              )}
              <select value={hour} aria-label={t('schedules.hour')} onChange={(event) => setHour(Number(event.target.value))}>
                {Array.from({ length: 24 }, (_, value) => (
                  <option key={value} value={value}>
                    {`${String(value).padStart(2, '0')}:00`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <small>{t('schedules.hint')}</small>
          <div className="agent-schedule-row">
            <button type="submit" className="settings-save" disabled={prompt.trim().length < 3}>
              <AlarmClock size={13} />
              {t('schedules.create')}
            </button>
            <button type="button" className="settings-link" onClick={onCloseForm}>
              {t('schedules.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
