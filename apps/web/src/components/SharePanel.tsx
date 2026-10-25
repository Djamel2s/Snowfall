import { useEffect, useState } from 'react'
import { Building2, Check, Pencil, User, Users, X } from 'lucide-react'
import { api, type AccessGrant, type SharingDirectory } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Props = {
  resource: { type: 'agent' | 'prompt' | 'skill'; id: string; name: string }
  onError: (message: string) => void
}

const key = (grant: AccessGrant) => (grant.principal.type === 'organization' ? 'organization' : `${grant.principal.type}:${grant.principal.id}`)

/**
 * Partage d'un agent ou d'un prompt : avec qui (une personne, un groupe, toute
 * l'organisation) et pour quoi faire (lecture ou modification). Enregistré d'un
 * bloc ; la base applique ces droits même si l'interface se trompait.
 */
export default function SharePanel({ resource, onError }: Props) {
  const { t } = useI18n()
  const [directory, setDirectory] = useState<SharingDirectory | null>(null)
  const [saved, setSaved] = useState<AccessGrant[]>([])
  const [grants, setGrants] = useState<AccessGrant[] | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.sharingDirectory(), api.getAccess(resource.type, resource.id)])
      .then(([found, current]) => {
        if (cancelled) return
        setDirectory(found)
        setSaved(current)
        setGrants(current)
      })
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [resource.type, resource.id, onError])

  if (!directory || !grants) return null

  const label = (grant: AccessGrant) => {
    if (grant.principal.type === 'organization') return t('share.everyone')
    const id = grant.principal.id
    if (grant.principal.type === 'group') return directory.groups.find((group) => group.id === id)?.name ?? t('share.unknown')
    return directory.members.find((member) => member.userId === id)?.email ?? t('share.unknown')
  }
  const taken = new Set(grants.map(key))
  const options = [
    ...(!taken.has('organization') ? [{ value: 'organization', label: t('share.everyone') }] : []),
    ...directory.groups.filter((group) => !taken.has(`group:${group.id}`)).map((group) => ({ value: `group:${group.id}`, label: t('share.groupOption', { name: group.name, count: group.memberCount }) })),
    ...directory.members.filter((member) => !taken.has(`user:${member.userId}`)).map((member) => ({ value: `user:${member.userId}`, label: member.email })),
  ]
  const changed = JSON.stringify(grants) !== JSON.stringify(saved)

  function add(value: string) {
    if (!value || !grants) return
    const [type, id] = value.split(':') as ['organization' | 'group' | 'user', string | undefined]
    const principal: AccessGrant['principal'] = type === 'organization' ? { type } : { type, id: id! }
    setGrants([...grants, { principal, permission: 'view' }])
    setChoice('')
    setDone(false)
  }

  async function save() {
    if (!grants) return
    setBusy(true)
    try {
      const next = await api.setAccess(resource.type, resource.id, grants)
      setSaved(next)
      setGrants(next)
      setDone(true)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-card share-panel" aria-label={t('share.accessTitle', { name: resource.name })}>
      <h3>{t('share.access')}</h3>
      {grants.length === 0 && <p className="settings-hint">{t('share.private')}</p>}
      <ul className="share-grants">
        {grants.map((grant) => (
          <li key={key(grant)}>
            {grant.principal.type === 'organization' ? <Building2 size={13} /> : grant.principal.type === 'group' ? <Users size={13} /> : <User size={13} />}
            <span className="share-who" title={label(grant)}>
              {label(grant)}
            </span>
            <div className="settings-segmented" role="radiogroup" aria-label={t('share.permissionFor', { name: label(grant) })}>
              {(['view', 'edit'] as const).map((permission) => (
                <button
                  key={permission}
                  type="button"
                  role="radio"
                  aria-checked={grant.permission === permission}
                  onClick={() => {
                    setGrants(grants.map((item) => (key(item) === key(grant) ? { ...item, permission } : item)))
                    setDone(false)
                  }}
                >
                  {permission === 'edit' ? <Pencil size={11} /> : null}
                  {t(`share.permission.${permission}`)}
                </button>
              ))}
            </div>
            <button type="button" className="icon-button" aria-label={t('share.remove', { name: label(grant) })} title={t('share.revoke')} onClick={() => {
              setGrants(grants.filter((item) => key(item) !== key(grant)))
              setDone(false)
            }}>
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
      {options.length > 0 && (
        <select className="share-add" aria-label={t('share.add')} value={choice} onChange={(event) => add(event.target.value)}>
          <option value="">{t('share.add')}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="settings-save" disabled={busy || !changed} onClick={() => void save()}>
        <Check size={14} />
        {done && !changed ? t('settings.saved') : t('share.save')}
      </button>
    </section>
  )
}
