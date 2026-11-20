import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, ExternalLink, KeyRound, Plus, Trash2 } from 'lucide-react'
import { api, type CustomProviderStatus, type KeyProvider, type ModelKeysView, type ModelKeyStatus, type OrganizationSettings } from '../lib/api'
import { useI18n, type MessageKey } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import { ProviderLogo } from './AgentAvatar'
import { useCatalogView } from '../lib/catalog-view'
import { GridTile, ListEmpty, ListGrid, ListRow, ListRows, ListSection, PanelNew, PanelSearch, ViewToggle } from './ui/List'

type Props = {
  isAdmin: boolean
  /** Fournisseur à ouvrir directement (depuis le choix du modèle). */
  openProvider?: KeyProvider | undefined
  /** Clés changées : catalogue des modèles à relire. */
  onChanged?: () => void
  onError: (message: string) => void
}

type Open = { kind: 'provider'; id: KeyProvider } | { kind: 'custom'; id: string } | { kind: 'new' } | null

/** Où obtenir une clé, chez chaque fournisseur. */
const keyPages: Record<KeyProvider, string> = {
  mistral: 'https://console.mistral.ai/api-keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/** Ce qui sert mes réponses, en quelques mots. */
function sourceLabel(item: ModelKeyStatus, t: Translate) {
  if (item.active === 'personal' && item.personal) return t('models.source.personal', { hint: item.personal.hint })
  if (item.active === 'organization') return t('models.source.organization')
  if (item.active === 'platform') return t('models.source.platform')
  return t('models.source.none')
}

/** Une entrée de la liste : fournisseur intégré ou personnalisé, même présentation. */
type Entry = { key: string; name: string; logo: 'custom' | KeyProvider; ready: boolean; chip: { label: string; tone: string }; subtitle?: string | undefined; open: Open }

function entries(view: ModelKeysView, t: Translate): Entry[] {
  const builtIn = view.providers.map((item): Entry => ({
    key: item.id,
    name: providerMeta[item.id].label,
    logo: item.id,
    ready: Boolean(item.allowed && item.active),
    chip: !item.allowed ? { label: t('models.chip.off'), tone: 'muted' } : item.active ? { label: t('models.chip.ready'), tone: 'ok' } : { label: t('models.chip.connect'), tone: 'warn' },
    // La source seulement quand une clé sert : l'état est déjà dans la pastille.
    subtitle: item.active ? sourceLabel(item, t) : undefined,
    open: { kind: 'provider', id: item.id },
  }))
  const custom = view.custom.map((item): Entry => ({
    key: item.id,
    name: item.name,
    logo: 'custom',
    ready: item.allowed && item.models > 0,
    chip: !item.allowed ? { label: t('models.chip.off'), tone: 'muted' } : item.models > 0 ? { label: t('models.chip.ready'), tone: 'ok' } : { label: t('models.chip.down'), tone: 'warn' },
    subtitle: item.allowed && item.models > 0 ? t('models.custom.count', { count: item.models }) : undefined,
    open: { kind: 'custom', id: item.id },
  }))
  return [...builtIn, ...custom]
}

/**
 * Modèles (barre latérale) : les fournisseurs, et pour chacun la clé qui sert mes
 * réponses. Un membre pose SA clé si l'organisation l'autorise ; un administrateur
 * pose celle de l'organisation, décide des clés personnelles et ajoute des
 * fournisseurs personnalisés (serveurs compatibles OpenAI). Même format que les connecteurs.
 */
export default function ModelsPanel({ isAdmin, openProvider, onChanged, onError }: Props) {
  const { t } = useI18n()
  const [data, setData] = useState<ModelKeysView | null>(null)
  const [open, setOpen] = useState<Open>(openProvider ? { kind: 'provider', id: openProvider } : null)
  const [query, setQuery] = useState('')
  const [view, setView] = useCatalogView('models')

  useEffect(() => {
    let cancelled = false
    api
      .listModelKeys()
      .then((value) => !cancelled && setData(value))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [onError])

  const update = (next: ModelKeysView) => {
    setData(next)
    onChanged?.()
  }

  if (open?.kind === 'new' && isAdmin) {
    return (
      <div className="settings-panel connectors-panel models-panel">
        <NewProvider
          onBack={() => setOpen(null)}
          onError={onError}
          onAdded={(next) => {
            // Le fournisseur ajouté : celui qui n'existait pas encore.
            const added = next.custom.find((item) => !data?.custom.some((known) => known.id === item.id))
            update(next)
            setOpen(added ? { kind: 'custom', id: added.id } : null)
          }}
        />
      </div>
    )
  }

  const provider = open?.kind === 'provider' ? data?.providers.find((item) => item.id === open.id) : undefined
  if (provider) {
    return (
      <div className="settings-panel connectors-panel models-panel">
        <ProviderDetail key={provider.id} item={provider} isAdmin={isAdmin} onBack={() => setOpen(null)} onChanged={update} onError={onError} />
      </div>
    )
  }

  const custom = open?.kind === 'custom' ? data?.custom.find((item) => item.id === open.id) : undefined
  if (custom) {
    return (
      <div className="settings-panel connectors-panel models-panel">
        <CustomDetail
          key={custom.id}
          item={custom}
          isAdmin={isAdmin}
          onBack={() => setOpen(null)}
          onError={onError}
          onRemoved={(next) => {
            update(next)
            setOpen(null)
          }}
        />
      </div>
    )
  }

  const needle = query.trim().toLocaleLowerCase()
  const shown = data ? entries(data, t).filter((item) => !needle || item.name.toLocaleLowerCase().includes(needle)) : []

  return (
    <div className="list-panel connectors-panel models-panel">
      {isAdmin && <PanelNew label={t('models.new')} onClick={() => setOpen({ kind: 'new' })} />}
      <PanelSearch value={query} onChange={setQuery} placeholder={t('models.search')} />
      <ListSection label={t('models.providers')} actions={<ViewToggle view={view} onChange={setView} />}>
        {data === null ? (
          <ListEmpty>{t('common.loading')}</ListEmpty>
        ) : !shown.length ? (
          <ListEmpty>{t('models.noMatch')}</ListEmpty>
        ) : view === 'grid' ? (
          <ListGrid label={t('models.providers')}>
            {shown.map((item) => (
              <GridTile
                key={item.key}
                icon={<ProviderLogo provider={item.logo} size={28} />}
                title={item.name}
                label={t('models.open', { name: item.name })}
                tooltip={item.chip.label}
                onClick={() => setOpen(item.open)}
                badge={item.ready ? <span className="grid-tile-added" aria-label={t('models.chip.ready')} title={t('models.chip.ready')} /> : undefined}
              />
            ))}
          </ListGrid>
        ) : (
          <ListRows>
            {shown.map((item) => (
              <ListRow
                key={item.key}
                icon={<ProviderLogo provider={item.logo} size={20} />}
                title={item.name}
                subtitle={item.subtitle}
                label={t('models.open', { name: item.name })}
                onClick={() => setOpen(item.open)}
                trailing={<span className={`list-row-chip ${item.chip.tone}`}>{item.chip.label}</span>}
              />
            ))}
          </ListRows>
        )}
      </ListSection>
      <p className="settings-hint">{t('models.hint')}</p>
    </div>
  )
}

/** Nouveau fournisseur : un serveur compatible OpenAI, vérifié avant d'être ajouté. */
function NewProvider({ onBack, onAdded, onError }: { onBack: () => void; onAdded: (next: ModelKeysView) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '' })
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError('')
    try {
      const apiKey = form.apiKey.trim()
      const next = await api.addModelProvider({ name: form.name.trim(), baseUrl: form.baseUrl.trim(), ...(apiKey ? { apiKey } : {}) })
      // La clé ne reste jamais dans la page.
      setForm({ name: '', baseUrl: '', apiKey: '' })
      onAdded(next)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="connector-detail" aria-label={t('models.custom.title')}>
      <button type="button" className="connector-back" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('models.back')}
      </button>
      <h3>{t('models.custom.title')}</h3>
      <p className="settings-hint">{t('models.custom.how')}</p>
      <form className="connector-form" aria-label={t('models.custom.title')} onSubmit={(event) => void submit(event)}>
        <input required aria-label={t('models.custom.name')} placeholder={t('models.custom.name')} value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input required type="url" aria-label={t('models.custom.url')} placeholder={t('models.custom.url')} value={form.baseUrl} maxLength={500} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <input type="password" autoComplete="off" spellCheck={false} aria-label={t('models.custom.key')} placeholder={t('models.custom.key')} value={form.apiKey} maxLength={512} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
        <button type="submit" className="settings-save connector-primary" disabled={busy || !form.name.trim() || !form.baseUrl.trim()}>
          <Plus size={14} />
          {t('models.custom.add')}
        </button>
      </form>
    </section>
  )
}

/** Fiche d'un fournisseur personnalisé : l'état ; pour un administrateur, l'adresse et le retrait. */
function CustomDetail({ item, isAdmin, onBack, onRemoved, onError }: { item: CustomProviderStatus; isAdmin: boolean; onBack: () => void; onRemoved: (next: ModelKeysView) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)

  async function remove() {
    setBusy(true)
    onError('')
    try {
      onRemoved(await api.removeModelProvider(item.id))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="connector-detail" aria-label={item.name}>
      <button type="button" className="connector-back" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('models.back')}
      </button>

      <header className="connector-detail-head">
        <ProviderLogo provider="custom" size={44} />
        <div>
          <h3>{item.name}</h3>
        </div>
      </header>

      {!item.allowed ? (
        <p className="connector-state">{t('models.state.off')}</p>
      ) : item.models > 0 ? (
        <p className="connector-state connector-ready-line">
          <Check size={14} />
          {t('models.custom.ready', { count: item.models })}
        </p>
      ) : (
        <p className="connector-state">{t('models.custom.down')}</p>
      )}

      {isAdmin && (
        <div className="connector-admin" aria-label={t('models.admin.title')}>
          <div className="connector-action">
            <p>{t('models.custom.address')}</p>
            <p className="connector-ready-line">{item.baseUrl}</p>
            {item.hint && (
              <p className="connector-ready-line">
                <KeyRound size={14} />
                ••••{item.hint}
              </p>
            )}
            <div className="connector-actions">
              <button
                type="button"
                className={`settings-secondary connector-delete${armed ? ' armed' : ''}`}
                disabled={busy}
                onBlur={() => setArmed(false)}
                onClick={() => {
                  if (!armed) return setArmed(true)
                  setArmed(false)
                  void remove()
                }}
              >
                <Trash2 size={13} />
                {armed ? t('models.confirmRemove') : t('models.remove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/** Fiche d'un fournisseur : l'état, UNE action principale (ma clé), puis le bloc administrateur. */
function ProviderDetail({ item, isAdmin, onBack, onChanged, onError }: { item: ModelKeyStatus; isAdmin: boolean; onBack: () => void; onChanged: (next: ModelKeysView) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const name = providerMeta[item.id].label
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState<OrganizationSettings | null>(null)

  // Réglages de l'organisation (politique des clés personnelles) : administrateur seulement.
  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    api
      .getOrganization()
      .then((value) => !cancelled && setSettings(value.settings))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [isAdmin, onError])

  async function act(action: () => Promise<void>) {
    setBusy(true)
    onError('')
    try {
      await action()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const reload = async () => onChanged(await api.listModelKeys())
  const personalOn = settings?.personalKeyProviders?.includes(item.id) ?? item.personalAllowed

  return (
    <section className="connector-detail" aria-label={name}>
      <button type="button" className="connector-back" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('models.back')}
      </button>

      <header className="connector-detail-head">
        <ProviderLogo provider={item.id} size={44} />
        <div>
          <h3>{name}</h3>
        </div>
      </header>

      {!item.allowed ? (
        <p className="connector-state">{t('models.state.off')}</p>
      ) : item.active ? (
        <p className="connector-state connector-ready-line">
          <Check size={14} />
          {t('models.state.ready', { name, source: t(`models.via.${item.active}`) })}
        </p>
      ) : !item.personalAllowed && !isAdmin ? (
        <p className="connector-state">{t('models.state.unavailable')}</p>
      ) : null}

      {/* Ma clé : à poser si l'organisation l'autorise ; toujours retirable. */}
      {((item.allowed && item.personalAllowed) || item.personal) && (
        <KeyBlock
          canSet={item.allowed && item.personalAllowed}
          title={t('models.mine')}
          hint={t('models.personalHint', { name })}
          provider={item.id}
          current={item.personal?.hint}
          busy={busy}
          onSave={(apiKey) => act(async () => onChanged(await api.setModelKey('personal', item.id, apiKey)))}
          onRemove={() => act(async () => onChanged(await api.removeModelKey('personal', item.id)))}
        />
      )}

      {isAdmin && item.allowed && (
        <div className="connector-admin" aria-label={t('models.admin.title')}>
          <KeyBlock
            canSet
            title={t('models.admin.key')}
            hint={t('models.admin.keyHint')}
            provider={item.id}
            current={item.organization ? (item.organization.hint ?? '') : undefined}
            busy={busy}
            onSave={(apiKey) => act(async () => onChanged(await api.setModelKey('organization', item.id, apiKey)))}
            onRemove={() => act(async () => onChanged(await api.removeModelKey('organization', item.id)))}
          />
          {settings && (
            <label className="settings-row settings-switch">
              <span>
                {t('models.admin.personal')}
                <small>{t('models.admin.personalHint')}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={`${t('models.admin.personal')} · ${name}`}
                checked={personalOn}
                disabled={busy}
                onChange={(event) => {
                  // Bascule aussitôt ; revient en arrière si l'enregistrement échoue.
                  const previous = settings
                  const others = (settings.personalKeyProviders ?? []).filter((id) => id !== item.id)
                  const next = { ...settings, personalKeyProviders: event.target.checked ? [...others, item.id] : others }
                  setSettings(next)
                  void act(async () => {
                    try {
                      setSettings(await api.saveOrganizationSettings(next))
                      await reload()
                    } catch (cause) {
                      setSettings(previous)
                      throw cause
                    }
                  })
                }}
              />
            </label>
          )}
        </div>
      )}
    </section>
  )
}

/** Une clé : posée (••••abcd, remplacer, retirer en deux clics) ou à saisir. */
function KeyBlock({ canSet, title, hint, provider, current, busy, onSave, onRemove }: { canSet: boolean; title: string; hint: string; provider: KeyProvider; current: string | undefined; busy: boolean; onSave: (apiKey: string) => Promise<void>; onRemove: () => Promise<void> }) {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [armed, setArmed] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const apiKey = value.trim()
    if (!apiKey) return
    await onSave(apiKey)
    // La clé ne reste jamais dans la page.
    setValue('')
    setEditing(false)
  }

  return (
    <div className="connector-action">
      <p>{title}</p>
      {current !== undefined && !editing ? (
        <>
          <p className="connector-ready-line">
            <KeyRound size={14} />
            {current ? `••••${current}` : t('models.source.organization')}
          </p>
          <div className="connector-actions">
            {canSet && (
              <button type="button" className="settings-secondary" disabled={busy} onClick={() => setEditing(true)}>
                {t('models.replace')}
              </button>
            )}
            <button
              type="button"
              className={`settings-secondary connector-delete${armed ? ' armed' : ''}`}
              disabled={busy}
              onBlur={() => setArmed(false)}
              onClick={() => {
                if (!armed) return setArmed(true)
                setArmed(false)
                void onRemove()
              }}
            >
              <Trash2 size={13} />
              {armed ? t('models.confirmRemove') : t('models.remove')}
            </button>
          </div>
        </>
      ) : (
        <form className="connector-form" aria-label={title} onSubmit={(event) => void submit(event)}>
          <input
            required
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${title} · ${t('models.key')}`}
            placeholder={t('models.key')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="connector-actions">
            <button type="submit" className="settings-save connector-primary" disabled={busy || !value.trim()}>
              <KeyRound size={14} />
              {t('models.connect')}
            </button>
            {editing ? (
              <button type="button" className="settings-secondary" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            ) : (
              <a className="settings-secondary" href={keyPages[provider]} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} />
                {t('models.getKey')}
              </a>
            )}
          </div>
        </form>
      )}
      <p className="settings-hint">{hint}</p>
    </div>
  )
}
