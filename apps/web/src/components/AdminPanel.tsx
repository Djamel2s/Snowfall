import { useEffect, useState, type FormEvent } from 'react'
import { BookOpen, Check, Cpu, LayoutDashboard, Trash2, UserPlus, Users, Wrench, X } from 'lucide-react'
import { getSession } from '../auth/session'
import {
  api,
  providerIds,
  toolAccess,
  toolIds,
  toolMeters,
  type Invitation,
  type Member,
  type ModelSelection,
  type Organization,
  type OrganizationSettings,
  type ProviderCatalog,
  type ProviderId,
  type Role,
} from '../lib/api'
import GroupsSettings from './GroupsSettings'
import ApiKeysSettings from './ApiKeysSettings'
import { useI18n } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import { ProviderLogo } from './AgentAvatar'
import DecisionWorkshop from './DecisionWorkshop'
import AdminOverview from './AdminOverview'

// Administration de l'organisation (administrateurs) : un espace à part des
// réglages personnels. Une fonction s'insère dans une rubrique, elle n'en crée
// pas une de plus sans raison.

const roles: Role[] = ['owner', 'admin', 'member', 'reader']

const sections = [
  { id: 'overview', icon: LayoutDashboard },
  { id: 'members', icon: Users },
  { id: 'models', icon: Cpu },
  { id: 'knowledge', icon: BookOpen },
  { id: 'tools', icon: Wrench },
] as const
type Section = (typeof sections)[number]['id']

type Routing = { fast: ModelSelection; strong: ModelSelection }

/** Routage automatique : deux modèles publiés, parmi les fournisseurs autorisés. */
function RoutingSettings({ value, choices, onChange }: { value: Routing | null; choices: ProviderCatalog[]; onChange: (value: Routing | null) => void }) {
  const { t } = useI18n()
  const options = choices.flatMap((provider) => provider.models.map((model) => ({ key: `${provider.id}:${model.id}`, selection: { provider: provider.id, model: model.id }, label: `${providerMeta[provider.id].label} · ${model.label}` })))
  if (!options.length && !value) return null
  const keyOf = (selection: ModelSelection) => `${selection.provider}:${selection.model}`
  const pick = (key: string) => options.find((option) => option.key === key)?.selection
  return (
    <>
      <label className="settings-row settings-switch">
        <span>
          {t('settings.routing')}
          <small>{t('settings.routingHint')}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={value !== null}
          disabled={!value && !options.length}
          onChange={(event) => onChange(event.target.checked && options[0] ? { fast: options[0].selection, strong: (options.at(-1) ?? options[0]).selection } : null)}
        />
      </label>
      {value &&
        (['fast', 'strong'] as const).map((role) => (
          <label key={role} className="settings-field">
            <span>{t(role === 'fast' ? 'settings.routingFast' : 'settings.routingStrong')}</span>
            <select value={keyOf(value[role])} onChange={(event) => { const selection = pick(event.target.value); if (selection) onChange({ ...value, [role]: selection }) }}>
              {/* Modèle enregistré retiré du catalogue : affiché tel quel, l'API le refusera. */}
              {!pick(keyOf(value[role])) && <option value={keyOf(value[role])}>{keyOf(value[role])}</option>}
              {options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
    </>
  )
}

export default function AdminPanel() {
  const { t, formatNumber } = useI18n()
  const session = getSession()
  const isOwner = session.user.role === 'owner'

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
  const [section, setSection] = useState<Section>('overview')
  // Modèles publiés, pour le routage automatique.
  const [catalog, setCatalog] = useState<ProviderCatalog[]>([])

  useEffect(() => {
    let cancelled = false
    const fail = (cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause))
    api
      .getOrganization()
      .then((value) => {
        if (cancelled) return
        setOrganization(value)
        setDraft(value.settings)
        if (value.organization.sso) setSso({ alias: value.organization.sso.alias ?? '', defaultRole: value.organization.sso.defaultRole })
      })
      .catch(fail)
    api.listModels().then((value) => !cancelled && setCatalog(value)).catch(fail)
    api
      .listMembers()
      .then((value) => {
        if (cancelled) return
        setMembers(value.members)
        setInvitations(value.invitations)
      })
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

  return (
    <div className="settings-panel">
      <div className="sidebar-section-label">{t('admin.title').toUpperCase()}</div>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <nav className="settings-sections" role="tablist" aria-label={t('admin.title')}>
        {sections.map(({ id, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}>
            <Icon size={14} />
            {t(`admin.section.${id}`)}
          </button>
        ))}
      </nav>

      {section === 'overview' && <AdminOverview onError={setError} />}

      {section !== 'overview' && !draft && <p className="settings-hint">{t('common.loading')}</p>}

      {section === 'models' && draft && (
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

          <label className="settings-row settings-switch">
            <span>
              {t('sensitive.setting')}
              <small>{t('sensitive.settingHint')}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={(draft.sensitiveData ?? 'local') === 'local'}
              onChange={(event) => setDraft({ ...draft, sensitiveData: event.target.checked ? 'local' : 'off' })}
            />
          </label>
          <label className="settings-row settings-switch">
            <span>
              {t('pseudonymize.setting')}
              <small>{t('pseudonymize.settingHint')}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={draft.pseudonymize === true}
              onChange={(event) => setDraft({ ...draft, pseudonymize: event.target.checked })}
            />
          </label>

          <RoutingSettings
            value={draft.modelRouting ?? null}
            choices={catalog.filter((provider) => provider.available && draft.allowedProviders.includes(provider.id))}
            onChange={(modelRouting) => setDraft({ ...draft, modelRouting })}
          />
          <DecisionWorkshop onError={setError} />

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
          {/* Outils comptés (code, web, MCP) : seulement ceux que la plateforme fournit. */}
          {toolMeters
            .filter(({ tool }) => (organization?.platformTools ?? toolIds).includes(tool))
            .map(({ id }) => (
              <label key={id} className="settings-field">
                <span>{t('settings.quotaTool', { tool: t(`settings.meter.${id}`) })}</span>
                <input
                  inputMode="numeric"
                  placeholder={t('settings.quotaPlaceholder')}
                  value={draft.toolLimits[id] ?? ''}
                  onChange={(event) => {
                    const limits = { ...draft.toolLimits }
                    const value = limitValue(event.target.value)
                    if (value === null) delete limits[id]
                    else limits[id] = value
                    setDraft({ ...draft, toolLimits: limits })
                  }}
                />
              </label>
            ))}
          <button
            type="button"
            className="settings-save"
            onClick={() =>
              void run('settings', async () => {
                setDraft(await api.saveOrganizationSettings(draft))
              })
            }
          >
            <Check size={14} />
            {saved === 'settings' ? t('settings.saved') : t('common.save')}
          </button>
        </section>

      )}

      {section === 'knowledge' && draft && (
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

      )}

      {section === 'tools' && draft && (
        <>
          <section className="settings-card" aria-label={t('settings.tools')}>
            <h3>{t('settings.tools')}</h3>
            {/* Un outil non installé reste visible (grisé) : on sait qu'il existe et pourquoi il manque. */}
            {toolIds.map((id) => {
              const installed = (organization?.platformTools ?? toolIds).includes(id)
              return (
                <label key={id} className={`settings-row settings-switch ${installed ? '' : 'disabled'}`}>
                  <span>
                    {t(`tool.${id}`)}
                    {!installed ? (
                      <small className="settings-hint"> · {t('settings.toolNotInstalled')}</small>
                    ) : (
                      toolAccess[id] === 'write' && <small className="settings-hint"> · {t('tool.approvalRequired')}</small>
                    )}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    disabled={!installed}
                    checked={installed && draft.tools.includes(id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        tools: event.target.checked ? toolIds.filter((tool) => tool === id || draft.tools.includes(tool)) : draft.tools.filter((tool) => tool !== id),
                      })
                    }
                  />
                </label>
              )
            })}
            <button
              type="button"
              className="settings-save"
              onClick={() =>
                void run('tools', async () => {
                  setDraft(await api.saveOrganizationSettings(draft))
                })
              }
            >
              <Check size={14} />
              {saved === 'tools' ? t('settings.saved') : t('common.save')}
            </button>
          </section>

          {/* Serveurs MCP et catalogue : barre latérale › Connecteurs (pas un réglage de plus ici). */}
          {(organization?.platformTools ?? []).includes('mcp') && <p className="settings-hint">{t('connectors.movedHint')}</p>}

          {/* Applications tierces : clés de l'API Snowfall (/v1). */}
          <ApiKeysSettings onError={setError} />
        </>
      )}

      {section === 'members' && draft && (
        <>
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

          <GroupsSettings members={members} onError={setError} />
          {/* Annuaire de l'entreprise (Entra ID, Okta…) : comptes créés et retirés automatiquement. */}
          <ApiKeysSettings kind="scim" onError={setError} />

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
