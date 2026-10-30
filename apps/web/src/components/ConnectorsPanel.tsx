import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ArrowLeft, ExternalLink, Link2, Plus } from 'lucide-react'
import { api, type CatalogConnector, type McpConnection, type McpServer } from '../lib/api'
import { useI18n } from '../lib/i18n'
import ConnectorLogo from './ConnectorLogo'
import ConnectorDetail from './connectors/ConnectorDetail'
import CustomConnector from './connectors/CustomConnector'
import { ListEmpty, ListRow, ListRows, ListSection, PanelNew, PanelSearch } from './ui/List'

type Props = {
  isAdmin: boolean
  /** Retour d'une connexion (message), et le connecteur concerné : sa fiche s'ouvre. */
  notice?: string | undefined
  returnedServerId?: string | undefined
  onError: (message: string) => void
}

type View = { kind: 'list' } | { kind: 'server'; id: string } | { kind: 'catalog'; id: string } | { kind: 'custom' }

const categories = ['all', 'google', 'microsoft', 'productivity', 'documents', 'communication', 'meetings', 'design', 'development', 'crm', 'finance', 'search', 'automation'] as const

/**
 * Connecteurs (barre latérale). Une liste, une fiche par connecteur, une action
 * principale à la fois : ajouter → se connecter → choisir les outils → prêt.
 */
export default function ConnectorsPanel({ isAdmin, notice, returnedServerId, onError }: Props) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<CatalogConnector[]>([])
  const [servers, setServers] = useState<McpServer[]>([])
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<View>(returnedServerId ? { kind: 'server', id: returnedServerId } : { kind: 'list' })
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<(typeof categories)[number]>('all')

  useEffect(() => {
    let cancelled = false
    Promise.all([api.mcpCatalog(), api.listMcpServers().catch(() => []), api.listMcpConnections().catch(() => [])])
      .then(([items, list, mine]) => {
        if (cancelled) return
        setCatalog(items)
        setServers(list)
        setConnections(mine)
        setLoaded(true)
      })
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [notice, onError])

  const byId = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog])
  const connected = new Set(connections.filter((item) => item.connected).map((item) => item.id))
  // Un membre ne voit que les connecteurs prêts à l'emploi.
  const listed = isAdmin ? servers : servers.filter((server) => server.status === 'approved')
  const needle = query.trim().toLowerCase()
  const shown = catalog.filter((item) => (category === 'all' || item.category === category) && (!needle || `${item.name} ${item.description}`.toLowerCase().includes(needle)))

  const status = (server: McpServer) => {
    if (server.status === 'disabled') return { label: t('connectors.chip.disabled'), tone: 'muted' }
    if (server.status === 'pending') return { label: t('connectors.chip.pending'), tone: 'warn' }
    if (server.auth === 'oauth' && !connected.has(server.id)) return { label: t('connectors.chip.login'), tone: 'warn' }
    return { label: t('connectors.chip.ready'), tone: 'ok' }
  }

  const updateServer = (next: McpServer | null, id: string) => {
    if (!next) {
      setServers((current) => current.filter((item) => item.id !== id))
      setView({ kind: 'list' })
      return
    }
    setServers((current) => current.map((item) => (item.id === id ? next : item)))
  }

  // ---- Fiche d'un connecteur ajouté ------------------------------------------
  if (view.kind === 'server') {
    const server = servers.find((item) => item.id === view.id)
    if (!server) return loaded ? <Back onBack={() => setView({ kind: 'list' })} /> : null
    return (
      <div className="settings-panel connectors-panel">
        {notice && <p className="settings-hint" role="status">{notice}</p>}
        <ConnectorDetail
          key={server.id}
          server={server}
          entry={server.catalogId ? byId.get(server.catalogId) : undefined}
          isAdmin={isAdmin}
          connected={connected.has(server.id)}
          onBack={() => setView({ kind: 'list' })}
          onChanged={(next) => updateServer(next, server.id)}
          onConnectedChange={(value) => setConnections((current) => current.map((item) => (item.id === server.id ? { ...item, connected: value } : item)))}
          onError={onError}
        />
      </div>
    )
  }

  // ---- Connecteur du catalogue, avant ajout ------------------------------------
  if (view.kind === 'catalog') {
    const entry = byId.get(view.id)
    if (!entry) return <Back onBack={() => setView({ kind: 'list' })} />
    return (
      <div className="settings-panel connectors-panel">
        <CatalogEntry
          entry={entry}
          onBack={() => setView({ kind: 'list' })}
          onAdded={(server) => {
            setServers((current) => [...current, server])
            setView({ kind: 'server', id: server.id })
          }}
          onError={onError}
        />
      </div>
    )
  }

  if (view.kind === 'custom') {
    return (
      <div className="settings-panel connectors-panel">
        <CustomConnector
          onBack={() => setView({ kind: 'list' })}
          onCreated={(server) => {
            setServers((current) => [...current, server])
            setView({ kind: 'server', id: server.id })
          }}
          onError={onError}
        />
      </div>
    )
  }

  // ---- Liste ----------------------------------------------------------------
  const addedShown = listed.filter((server) => !needle || `${server.name} ${server.catalogId ? (byId.get(server.catalogId)?.description ?? '') : ''}`.toLowerCase().includes(needle))
  return (
    <div className="list-panel connectors-panel">
      {isAdmin && <PanelNew label={t('connectors.new')} onClick={() => setView({ kind: 'custom' })} />}
      <PanelSearch value={query} onChange={setQuery} placeholder={t('connectors.search')} />
      {notice && <p className="settings-hint" role="status">{notice}</p>}

      <ListSection label={t('connectors.addedTitle')} ariaLabel={t('connectors.mine')}>
        {addedShown.length ? (
          <ListRows>
            {addedShown.map((server) => {
              const entry = server.catalogId ? byId.get(server.catalogId) : undefined
              const chip = status(server)
              return (
                <ListRow
                  key={server.id}
                  icon={<ConnectorLogo icon={entry?.icon ?? null} color={entry?.color ?? '#475569'} name={server.name} size={20} />}
                  title={server.name}
                  subtitle={entry?.description}
                  label={t('connectors.open', { name: server.name })}
                  onClick={() => setView({ kind: 'server', id: server.id })}
                  trailing={<span className={`list-row-chip ${chip.tone}`}>{chip.label}</span>}
                />
              )
            })}
          </ListRows>
        ) : (
          <ListEmpty>{needle ? t('connectors.noMatch') : isAdmin ? t('connectors.emptyAdmin') : t('connectors.empty')}</ListEmpty>
        )}
      </ListSection>

      {isAdmin && (
        <ListSection label={t('connectors.catalog')}>
          <div className="sidebar-tags connector-categories list-filters" role="group" aria-label={t('connectors.categories')}>
            {categories.map((value) => (
              <button key={value} type="button" className="sidebar-tag" aria-pressed={category === value} onClick={() => setCategory(value)}>
                {t(`connectors.category.${value}`)}
              </button>
            ))}
          </div>
          {shown.length ? (
            <ListRows>
              {shown.map((item) => {
                const added = servers.find((server) => server.catalogId === item.id)
                return (
                  <ListRow
                    key={item.id}
                    icon={<ConnectorLogo icon={item.icon} color={item.color} name={item.name} size={20} />}
                    title={item.name}
                    subtitle={item.description}
                    onClick={() => setView(added ? { kind: 'server', id: added.id } : { kind: 'catalog', id: item.id })}
                    trailing={added ? <span className="list-row-chip ok">{t('connectors.added')}</span> : undefined}
                  />
                )
              })}
            </ListRows>
          ) : (
            <ListEmpty>{t('connectors.noMatch')}</ListEmpty>
          )}
        </ListSection>
      )}
      <p className="settings-hint">{t('connectors.hint')}</p>
    </div>
  )
}

function Back({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  return (
    <div className="settings-panel connectors-panel">
      <button type="button" className="connector-back" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('connectors.back')}
      </button>
    </div>
  )
}

/** Fiche d'un connecteur du catalogue : ce qu'il fait, ce qu'il demande, un bouton. */
function CatalogEntry({ entry, onBack, onAdded, onError }: { entry: CatalogConnector; onBack: () => void; onAdded: (server: McpServer) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [form, setForm] = useState({ tenant: '', clientId: '', clientSecret: '', token: '' })
  const [busy, setBusy] = useState(false)
  const oauth = entry.auth === 'oauth'

  async function add(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError('')
    try {
      const server = await api.addCatalogConnector(entry.id, {
        ...(entry.tenant ? { tenant: form.tenant.trim() } : {}),
        ...(entry.auth === 'token' ? { token: form.token.trim() } : {}),
        ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
        ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
      })
      // OAuth : on enchaîne sur la connexion ; au retour, la fiche s'ouvre sur le choix des outils.
      if (oauth) window.location.assign(await api.connectMcp(server.id))
      else onAdded(server)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const notes = [
    entry.preview && t('connectors.note.preview'),
    entry.needsClient && t('connectors.note.needsClient'),
    entry.allowlist && t('connectors.note.allowlist'),
    entry.tenant && t('connectors.note.tenant'),
    entry.license && t('connectors.note.license', { license: entry.license }),
    entry.source === 'directory' && t('connectors.note.unverified'),
  ].filter(Boolean) as string[]

  return (
    <section className="connector-detail" aria-label={entry.name}>
      <button type="button" className="connector-back" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('connectors.back')}
      </button>
      <header className="connector-detail-head">
        <ConnectorLogo icon={entry.icon} color={entry.color} name={entry.name} size={44} />
        <div>
          <h3>{entry.name}</h3>
          <p>{entry.description}</p>
        </div>
      </header>

      <p className="settings-hint">{oauth ? t('connectors.how.oauth') : entry.auth === 'token' ? t('connectors.how.token') : t('connectors.how.open')}</p>
      {notes.length > 0 && (
        <ul className="connector-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      <form className="connector-form" aria-label={t('connectors.addNamed', { name: entry.name })} onSubmit={(event) => void add(event)}>
        {entry.tenant && <input required aria-label={t('connectors.tenant')} placeholder={t('connectors.tenant')} value={form.tenant} onChange={(event) => setForm({ ...form, tenant: event.target.value })} />}
        {entry.auth === 'token' && (
          <input required type="password" autoComplete="off" aria-label={t('connectors.token')} placeholder={t('connectors.token')} value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} />
        )}
        {oauth && entry.needsClient && (
          <>
            <input required aria-label={t('connectors.clientId')} placeholder={t('connectors.clientId')} value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} />
            <input type="password" autoComplete="off" aria-label={t('connectors.clientSecret')} placeholder={t('connectors.clientSecret')} value={form.clientSecret} onChange={(event) => setForm({ ...form, clientSecret: event.target.value })} />
          </>
        )}
        {oauth && !entry.needsClient && (
          <details className="connector-advanced">
            <summary>{t('connectors.oauthAdvanced')}</summary>
            <input aria-label={t('connectors.clientId')} placeholder={t('connectors.clientIdOptional')} value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} />
            <input type="password" autoComplete="off" aria-label={t('connectors.clientSecret')} placeholder={t('connectors.clientSecret')} value={form.clientSecret} onChange={(event) => setForm({ ...form, clientSecret: event.target.value })} />
          </details>
        )}
        <div className="connector-actions">
          <button type="submit" className="settings-save connector-primary" disabled={busy}>
            {oauth ? <Link2 size={14} /> : <Plus size={14} />}
            {oauth ? t('connectors.addAndConnect') : t('connectors.add')}
          </button>
          {entry.docs && (
            <a className="settings-secondary" href={entry.docs} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} />
              {t('connectors.docs')}
            </a>
          )}
        </div>
      </form>
    </section>
  )
}
