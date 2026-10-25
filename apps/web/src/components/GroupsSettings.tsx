import { useEffect, useState, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, Plus, Trash2, Users } from 'lucide-react'
import { api, type MemberGroup } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Props = {
  members: { userId: string; email: string }[]
  onError: (message: string) => void
}

/** Groupes de membres (administrateurs) : pour partager un agent ou un prompt d'un coup. */
export default function GroupsSettings({ members, onError }: Props) {
  const { t } = useI18n()
  const [groups, setGroups] = useState<MemberGroup[]>([])
  const [name, setName] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listGroups()
      .then((items) => !cancelled && setGroups(items))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [onError])

  const fail = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    try {
      const group = await api.createGroup(name.trim())
      setGroups((current) => [...current, group])
      setName('')
      setOpen(group.id)
    } catch (cause) {
      fail(cause)
    }
  }

  async function toggle(group: MemberGroup, userId: string) {
    const memberIds = group.memberIds.includes(userId) ? group.memberIds.filter((id) => id !== userId) : [...group.memberIds, userId]
    // Coché tout de suite ; annulé si le serveur refuse.
    setGroups((current) => current.map((item) => (item.id === group.id ? { ...item, memberIds } : item)))
    try {
      const updated = await api.updateGroup(group.id, { memberIds })
      setGroups((current) => current.map((item) => (item.id === group.id ? updated : item)))
    } catch (cause) {
      setGroups((current) => current.map((item) => (item.id === group.id ? group : item)))
      fail(cause)
    }
  }

  async function remove(group: MemberGroup) {
    if (armed !== group.id) return setArmed(group.id)
    try {
      await api.deleteGroup(group.id)
      setGroups((current) => current.filter((item) => item.id !== group.id))
    } catch (cause) {
      fail(cause)
    }
  }

  return (
    <section className="settings-card" aria-label={t('groups.title')}>
      <h3>{t('groups.title')}</h3>
      <p className="settings-hint">{t('groups.hint')}</p>
      <ul className="settings-members">
        {groups.map((group) => (
          <li key={group.id} className="group-item">
            <div className="group-row">
              <button type="button" className="group-toggle" aria-expanded={open === group.id} onClick={() => setOpen(open === group.id ? null : group.id)}>
                {open === group.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Users size={13} />
                <span className="settings-member-email">{group.name}</span>
                <small>{t('groups.count', { count: group.memberIds.length })}</small>
              </button>
              <button
                type="button"
                className={`settings-icon ${armed === group.id ? 'armed' : ''}`}
                aria-label={armed === group.id ? t('groups.confirmDelete', { name: group.name }) : t('groups.delete', { name: group.name })}
                title={t('common.delete')}
                onBlur={() => setArmed(null)}
                onClick={() => void remove(group)}
              >
                <Trash2 size={13} />
              </button>
            </div>
            {open === group.id && (
              <fieldset className="group-members">
                <legend>{t('groups.members', { name: group.name })}</legend>
                {members.map((member) => (
                  <label key={member.userId}>
                    <input type="checkbox" checked={group.memberIds.includes(member.userId)} onChange={() => void toggle(group, member.userId)} />
                    <span>{member.email}</span>
                  </label>
                ))}
              </fieldset>
            )}
          </li>
        ))}
      </ul>
      <form className="preset-form" onSubmit={(event) => void create(event)}>
        <input value={name} maxLength={60} placeholder={t('groups.name')} aria-label={t('groups.name')} onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="settings-save" disabled={!name.trim()}>
          <Plus size={13} />
          {t('groups.create')}
        </button>
      </form>
    </section>
  )
}
