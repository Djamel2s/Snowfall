import { useEffect, useState, type FormEvent } from 'react'
import { Check, ExternalLink, Trash2, UserPlus, X } from 'lucide-react'
import { getSession } from '../auth/session'
import {
  api,
  providerIds,
  type Invitation,
  type Member,
  type Organization,
  type OrganizationSettings,
  type Preferences,
  type ProviderId,
  type Role,
  type Usage,
} from '../lib/api'
import { useI18n, type Locale } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import { ProviderLogo } from './AgentAvatar'

type Props = {
  preferences: Preferences
  onPreferencesChange: (preferences: Preferences) => void
}

const roles: Role[] = ['owner', 'admin', 'member', 'reader']
const tokensOf = (totals?: { inputTokens: number; outputTokens: number }) =>
  (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0)

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null | undefined }) {
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

export default function SettingsPanel({ preferences, onPreferencesChange }: Props) {
  const { t, locale, setLocale, formatNumber } = useI18n()
  const session = getSession()
  const isAdmin = session.user.role === 'owner' || session.user.role === 'admin'
  const isOwner = session.user.role === 'owner'
  const name = session.profile.name ?? session.profile.username ?? session.profile.email ?? ''

  const [usage, setUsage] = useState<Usage | null>(null)
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [draft, setDraft] = useState<OrganizationSettings | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<Invitation['role']>('member')
  const [sso, setSso] = useState<{ alias: string; defaultRole: 'member' | 'reader' }>({ alias: '', defaultRole: 'member' })
  const [armed, setArmed] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState('')
  // Domaines autorisés en cours d'édition (null : valeur enregistrée).
  const [domainsText, setDomainsText] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fail = (cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause))

    api.getUsage().then((value) => !cancelled && setUsage(value)).catch(fail)
    api
      .getOrganization()
      .then((value) => {
        if (cancelled) return
        setOrganization(value)
        setDraft(value.settings)
        if (value.organization.sso) {
          setSso({ alias: value.organization.sso.alias ?? '', defaultRole: value.organization.sso.defaultRole })
        }
      })
      .catch(fail)
    if (isAdmin) {
      api
        .listMembers()
        .then((value) => {
          if (cancelled) return
          setMembers(value.members)
          setInvitations(value.invitations)
        })
        .catch(fail)
    }
    return () => {
      cancelled = true
    }
  }, [isAdmin])

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

  function toggleProvider(id: ProviderId) {
    if (!draft) return
    setDraft({
      ...draft,
      allowedProviders: draft.allowedProviders.includes(id)
        ? draft.allowedProviders.filter((item) => item !== id)
        : [...draft.allowedProviders, id],
    })
  }

  function limitValue(value: string) {
    const number = Number(value.replace(/\s/g, ''))
    return value.trim() === '' || !Number.isFinite(number) || number <= 0 ? null : Math.floor(number)
  }

  async function invite(event: FormEvent) {
    event.preventDefault()
    const email = inviteEmail.trim()
    if (!email) return
    await run('invite', async () => {
      const invitation = await api.invite(email, inviteRole)
      setInvitations((current) => [invitation, ...current])
      setInviteEmail('')
    })
  }

  const configured = organization?.configuredProviders ?? []
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
          <div className="user-avatar">{(name || '?').slice(0, 1).toUpperCase()}</div>
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
      </section>

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
            <p className="settings-hint">
              {t('settings.usageMine')} : {t('settings.tokens', { count: formatNumber(tokensOf(usage.usage.mine)) })}
            </p>
          </>
        ) : (
          <p className="settings-hint">{t('common.loading')}</p>
        )}
      </section>

      {isAdmin && draft && (
        <>
          <div className="sidebar-section-label">{t('settings.admin').toUpperCase()}</div>

          <section className="settings-card" aria-label={t('settings.providers')}>
            <h3>{t('settings.providers')}</h3>
            <div className="settings-providers">
              {providerIds.map((id) => {
                const available = configured.includes(id)
                return (
                  <label key={id} className={`settings-provider ${available ? '' : 'disabled'}`} title={available ? '' : t('settings.providerOff')}>
                    <ProviderLogo provider={id} size={16} />
                    <span>{providerMeta[id].label}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={draft.allowedProviders.includes(id)}
                      onChange={() => toggleProvider(id)}
                    />
                  </label>
                )
              })}
            </div>

            <h3>{t('settings.quotas')}</h3>
            <label className="settings-field">
              <span>{t('settings.quotaOrg')}</span>
              <input
                inputMode="numeric"
                placeholder={t('settings.quotaPlaceholder')}
                value={draft.monthlyTokenLimit ?? ''}
                onChange={(event) => setDraft({ ...draft, monthlyTokenLimit: limitValue(event.target.value) })}
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
                    const value = limitValue(event.target.value)
                    if (value === null) delete limits[id]
                    else limits[id] = value
                    setDraft({ ...draft, providerTokenLimits: limits })
                  }}
                />
              </label>
            ))}
            <button
              type="button"
              className="settings-save"
              onClick={() =>
                void run('settings', async () => {
                  const saved = await api.saveOrganizationSettings(draft)
                  setDraft(saved)
                  setUsage(await api.getUsage())
                })
              }
            >
              <Check size={14} />
              {saved === 'settings' ? t('settings.saved') : t('common.save')}
            </button>
          </section>

          <section className="settings-card" aria-label={t('settings.knowledge')}>
            <h3>{t('settings.knowledge')}</h3>
            <label className="settings-field">
              <span>{t('settings.embeddings')}</span>
              <select
                value={draft.embeddingProvider ?? ''}
                onChange={(event) =>
                  setDraft({ ...draft, embeddingProvider: (event.target.value || null) as OrganizationSettings['embeddingProvider'] })
                }
              >
                <option value="">{t('settings.embeddingsNone')}</option>
                {(organization?.embeddingProviders ?? [])
                  .filter((id) => id === 'local' || draft.allowedProviders.includes(id))
                  .map((id) => (
                    <option key={id} value={id}>
                      {providerMeta[id].label}
                    </option>
                  ))}
              </select>
            </label>
            <p className="settings-hint">{t('settings.embeddingsHint')}</p>
            <label className="settings-row settings-switch">
              <span>{t('settings.links')}</span>
              <input
                type="checkbox"
                role="switch"
                checked={draft.linksEnabled}
                onChange={(event) => setDraft({ ...draft, linksEnabled: event.target.checked })}
              />
            </label>
            {draft.linksEnabled && (
              <label className="settings-field">
                <span>{t('settings.linkDomains')}</span>
                <textarea
                  rows={3}
                  spellCheck={false}
                  placeholder="docs.exemple.com"
                  value={domainsText ?? draft.linkDomains.join('\n')}
                  onChange={(event) => setDomainsText(event.target.value)}
                />
              </label>
            )}
            <button
              type="button"
              className="settings-save"
              onClick={() =>
                void run('knowledge', async () => {
                  const linkDomains =
                    domainsText === null
                      ? draft.linkDomains
                      : [...new Set(domainsText.split(/[\s,]+/).map((item) => item.trim().toLowerCase()).filter(Boolean))]
                  const saved = await api.saveOrganizationSettings({ ...draft, linkDomains })
                  setDraft(saved)
                  setDomainsText(null)
                })
              }
            >
              <Check size={14} />
              {saved === 'knowledge' ? t('settings.saved') : t('common.save')}
            </button>
          </section>

          <section className="settings-card" aria-label={t('settings.members')}>
            <h3>{t('settings.members')}</h3>
            <ul className="settings-members">
              {members.map((member) => {
                const self = member.userId === session.user.userId
                const locked = self || (member.role === 'owner' && !isOwner)
                return (
                  <li key={member.userId}>
                    <div className="settings-member-main">
                      <span className="settings-member-email" title={member.email}>
                        {member.email}
                        {self && <small> ({t('common.you')})</small>}
                      </span>
                      <small>{t('settings.tokens', { count: formatNumber(member.monthlyTokens) })}</small>
                    </div>
                    <select
                      aria-label={member.email}
                      value={member.role}
                      disabled={locked}
                      onChange={(event) => {
                        const role = event.target.value as Role
                        void run(`role-${member.userId}`, async () => {
                          await api.setMemberRole(member.userId, role)
                          setMembers((current) => current.map((item) => (item.userId === member.userId ? { ...item, role } : item)))
                        })
                      }}
                    >
                      {roles
                        .filter((role) => isOwner || role !== 'owner' || member.role === 'owner')
                        .map((role) => (
                          <option key={role} value={role}>
                            {t(`role.${role}`)}
                          </option>
                        ))}
                    </select>
                    {!locked && (
                      <button
                        type="button"
                        className={`settings-icon ${armed === member.userId ? 'armed' : ''}`}
                        aria-label={t('settings.memberRemove', { email: member.email })}
                        title={armed === member.userId ? t('settings.memberRemoveConfirm') : t('common.delete')}
                        onBlur={() => setArmed(null)}
                        onClick={() => {
                          if (armed !== member.userId) {
                            setArmed(member.userId)
                            return
                          }
                          void run('remove', async () => {
                            await api.removeMember(member.userId)
                            setMembers((current) => current.filter((item) => item.userId !== member.userId))
                          })
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>

            <form className="settings-invite" onSubmit={(event) => void invite(event)}>
              <input
                type="email"
                aria-label={t('settings.inviteEmail')}
                placeholder={t('settings.inviteEmail')}
                value={inviteEmail}
                maxLength={254}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
              <select
                aria-label={t('settings.ssoRole')}
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Invitation['role'])}
              >
                {(['admin', 'member', 'reader'] as const).map((role) => (
                  <option key={role} value={role}>
                    {t(`role.${role}`)}
                  </option>
                ))}
              </select>
              <button type="submit" aria-label={t('settings.invite')} title={t('settings.invite')} disabled={!inviteEmail.trim()}>
                {saved === 'invite' ? <Check size={14} /> : <UserPlus size={14} />}
              </button>
            </form>
            <p className="settings-hint">{t('settings.inviteHint')}</p>

            {invitations.length > 0 && (
              <>
                <h4>{t('settings.invitations')}</h4>
                <ul className="settings-members">
                  {invitations.map((invitation) => (
                    <li key={invitation.id}>
                      <div className="settings-member-main">
                        <span className="settings-member-email">{invitation.email}</span>
                        <small>{t(`role.${invitation.role}`)}</small>
                      </div>
                      <button
                        type="button"
                        className="settings-icon"
                        aria-label={t('settings.invitationRevoke', { email: invitation.email })}
                        onClick={() =>
                          void run('revoke', async () => {
                            await api.revokeInvitation(invitation.id)
                            setInvitations((current) => current.filter((item) => item.id !== invitation.id))
                          })
                        }
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {isOwner && (
            <section className="settings-card" aria-label={t('settings.sso')}>
              <h3>{t('settings.sso')}</h3>
              <label className="settings-field">
                <span>{t('settings.ssoAlias')}</span>
                <input
                  value={sso.alias}
                  maxLength={63}
                  placeholder="acme"
                  onChange={(event) => setSso({ ...sso, alias: event.target.value.toLowerCase() })}
                />
              </label>
              <label className="settings-field">
                <span>{t('settings.ssoRole')}</span>
                <select
                  value={sso.defaultRole}
                  onChange={(event) => setSso({ ...sso, defaultRole: event.target.value as 'member' | 'reader' })}
                >
                  <option value="member">{t('role.member')}</option>
                  <option value="reader">{t('role.reader')}</option>
                </select>
              </label>
              <p className="settings-hint">{t('settings.ssoHint')}</p>
              <button
                type="button"
                className="settings-save"
                onClick={() =>
                  void run('sso', async () => {
                    await api.saveSso({ alias: sso.alias.trim() || null, defaultRole: sso.defaultRole })
                  })
                }
              >
                <Check size={14} />
                {saved === 'sso' ? t('settings.saved') : t('common.save')}
              </button>
            </section>
          )}
        </>
      )}
    </div>
  )
}
