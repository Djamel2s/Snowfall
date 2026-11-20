import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, ExternalLink, KeyRound, Trash2 } from 'lucide-react'
import { api, type KeyProvider, type ModelKeyStatus, type OrganizationSettings } from '../lib/api'
import { useI18n, type MessageKey } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import { ProviderLogo } from './AgentAvatar'
import { useCatalogView } from '../lib/catalog-view'
import { GridTile, ListEmpty, ListGrid, ListRow, ListRows, ListSection, PanelSearch, ViewToggle } from './ui/List'

type Props = {
  isAdmin: boolean
  /** Fournisseur à ouvrir directement (depuis le choix du modèle). */
  openProvider?: KeyProvider | undefined
  /** Clés changées : catalogue des modèles à relire. */
  onChanged?: () => void
  onError: (message: string) => void
}

/** Où obtenir une clé, chez chaque fournisseur. */
const keyPages: Record<KeyProvider, string> = {
  mistral: 'https://console.mistral.ai/api-keys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
}

/** Ce qui sert mes réponses, en quelques mots. */
function sourceLabel(item: ModelKeyStatus, t: (key: MessageKey, params?: Record<string, string | number>) => string) {
  if (item.active === 'personal' && item.personal) return t('models.source.personal', { hint: item.personal.hint })
  if (item.active === 'organization') return t('models.source.organization')
  if (item.active === 'platform') return t('models.source.platform')
  return t('models.source.none')
}

/**
 * Modèles (barre latérale) : les fournisseurs, et pour chacun la clé qui sert mes
 * réponses. Un membre pose SA clé si l'organisation l'autorise ; un administrateur
 * pose celle de l'organisation et décide des clés personnelles. Même format que les connecteurs.
 */
export default function ModelsPanel({ isAdmin, openProvider, onChanged, onError }: Props) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ModelKeyStatus[] | null>(null)
  const [open, setOpen] = useState<KeyProvider | null>(openProvider ?? null)
  const [query, setQuery] = useState('')
  const [view, setView] = useCatalogView('models')

  useEffect(() => {
    let cancelled = false
    api
      .listModelKeys()
      .then((list) => !cancelled && setProviders(list))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [onError])

  const update = (next: ModelKeyStatus[]) => {
    setProviders(next)
    onChanged?.()
  }

  const current = open ? providers?.find((item) => item.id === open) : undefined
  if (current) {
    return (
      <div className="settings-panel connectors-panel models-panel">
        <ProviderDetail key={current.id} item={current} isAdmin={isAdmin} onBack={() => setOpen(null)} onChanged={update} onError={onError} />
      </div>
    )
  }

  const chip = (item: ModelKeyStatus) =>
    !item.allowed ? { label: t('models.chip.off'), tone: 'muted' } : item.active ? { label: t('models.chip.ready'), tone: 'ok' } : { label: t('models.chip.connect'), tone: 'warn' }

  const needle = query.trim().toLocaleLowerCase()
  const shown = (providers ?? []).filter((item) => !needle || providerMeta[item.id].label.toLocaleLowerCase().includes(needle))

  return (
    <div className="list-panel connectors-panel models-panel">
      <PanelSearch value={query} onChange={setQuery} placeholder={t('models.search')} />
      <ListSection label={t('models.providers')} actions={<ViewToggle view={view} onChange={setView} />}>
        {providers === null ? (
          <ListEmpty>{t('common.loading')}</ListEmpty>
        ) : !shown.length ? (
          <ListEmpty>{t('models.noMatch')}</ListEmpty>
        ) : view === 'grid' ? (
          <ListGrid label={t('models.providers')}>
            {shown.map((item) => (
              <GridTile
                key={item.id}
                icon={<ProviderLogo provider={item.id} size={28} />}
                title={providerMeta[item.id].label}
                label={t('models.open', { name: providerMeta[item.id].label })}
                tooltip={chip(item).label}
                onClick={() => setOpen(item.id)}
                badge={item.active ? <span className="grid-tile-added" aria-label={t('models.chip.ready')} title={t('models.chip.ready')} /> : undefined}
              />
            ))}
          </ListGrid>
        ) : (
          <ListRows>
            {shown.map((item) => {
              const state = chip(item)
              return (
                <ListRow
                  key={item.id}
                  icon={<ProviderLogo provider={item.id} size={20} />}
                  title={providerMeta[item.id].label}
                  // La source seulement quand une clé sert : l'état est déjà dans la pastille.
                  subtitle={item.active ? sourceLabel(item, t) : undefined}
                  label={t('models.open', { name: providerMeta[item.id].label })}
                  onClick={() => setOpen(item.id)}
                  trailing={<span className={`list-row-chip ${state.tone}`}>{state.label}</span>}
                />
              )
            })}
          </ListRows>
        )}
      </ListSection>
      <p className="settings-hint">{t('models.hint')}</p>
    </div>
  )
}

/** Fiche d'un fournisseur : l'état, UNE action principale (ma clé), puis le bloc administrateur. */
function ProviderDetail({ item, isAdmin, onBack, onChanged, onError }: { item: ModelKeyStatus; isAdmin: boolean; onBack: () => void; onChanged: (next: ModelKeyStatus[]) => void; onError: (message: string) => void }) {
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
