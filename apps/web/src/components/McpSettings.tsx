import { useEffect, useState, type FormEvent } from 'react'
import { Check, FileJson, ListChecks, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, type McpDiscoveredTool, type McpServer } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Choice = { selected: boolean; access: 'read' | 'write' }

/**
 * Serveurs MCP de l'organisation (administrateurs) : ajout, examen des outils
 * publiés, approbation outil par outil (lecture ou écriture), suspension.
 */
export default function McpSettings({ onError }: { onError: (message: string) => void }) {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServer[]>([])
  const [form, setForm] = useState({ name: '', url: '', token: '', mode: 'token' as 'token' | 'oauth' | 'openapi', clientId: '', clientSecret: '', scope: '' })
  // Connecteur OpenAPI : spécification lue dans le navigateur, envoyée telle quelle (JSON).
  const [spec, setSpec] = useState<{ name: string; value: Record<string, unknown> } | null>(null)
  // Serveurs OAuth : l'admin examine les outils avec SON compte (connexion d'abord).
  const [connected, setConnected] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [tools, setTools] = useState<McpDiscoveredTool[]>([])
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .listMcpServers()
      .then((list) => !cancelled && setServers(list))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [onError])

  useEffect(() => {
    api
      .listMcpConnections()
      .then((items) => setConnected(new Set(items.filter((item) => item.connected).map((item) => item.id))))
      .catch(() => undefined)
  }, [servers])

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

  const replace = (server: McpServer) => setServers((current) => current.map((item) => (item.id === server.id ? server : item)))

  function add(event: FormEvent) {
    event.preventDefault()
    void act(async () => {
      const oauth = form.mode === 'oauth'
        ? { clientId: form.clientId.trim(), ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}), ...(form.scope.trim() ? { scope: form.scope.trim() } : {}) }
        : undefined
      const server = await api.createMcpServer({
        name: form.name.trim(),
        url: form.url.trim(),
        ...(oauth ? { oauth } : form.token.trim() ? { token: form.token.trim() } : {}),
        ...(form.mode === 'openapi' && spec ? { openapi: { spec: spec.value } } : {}),
      })
      setSpec(null)
      setServers((current) => [...current, server])
      setForm({ name: '', url: '', token: '', mode: 'token', clientId: '', clientSecret: '', scope: '' })
    })
  }

  /** Outils publiés par le serveur, relus ; les choix déjà faits sont gardés. */
  async function load(server: McpServer, previous: Record<string, Choice> = {}) {
    const discovered = await api.discoverMcpTools(server.id)
    setTools(discovered)
    // Par défaut : rien de coché ; écriture, sauf outil déjà approuvé en lecture.
    setChoices(
      Object.fromEntries(
        discovered.map((tool) => {
          const approved = server.tools.find((item) => item.name === tool.name)
          return [tool.name, previous[tool.name] ?? { selected: Boolean(approved), access: approved?.access ?? 'write' }]
        }),
      ),
    )
    setOpen(server.id)
  }

  function examine(server: McpServer) {
    if (server.auth === 'oauth' && !connected.has(server.id)) {
      void act(async () => window.location.assign(await api.connectMcp(server.id)))
      return
    }
    if (open === server.id) {
      setOpen(null)
      return
    }
    void act(() => load(server))
  }

  function approve(server: McpServer) {
    const selected = tools.filter((tool) => tool.supported && choices[tool.name]?.selected)
    void act(async () => {
      try {
        replace(await api.approveMcpServer(server.id, selected.map((tool) => ({ name: tool.name, access: choices[tool.name]!.access, fingerprint: tool.fingerprint }))))
        setOpen(null)
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 409)) throw cause
        // Le serveur a modifié un outil pendant l'examen : nouvelle version affichée, à relire.
        await load(server, choices)
        onError(t('mcp.changed'))
      }
    })
  }

  return (
    <section className="settings-card" aria-label={t('mcp.title')}>
      <h3>{t('mcp.title')}</h3>
      <ul className="settings-members">
        {servers.map((server) => (
          <li key={server.id} className="mcp-server">
            <div className="mcp-server-line">
              <div className="settings-member-main">
                <span className="settings-member-email" title={server.url}>
                  {server.name}
                </span>
                <small>
                  {server.kind === 'openapi' ? `${t('mcp.kind.openapi')} · ` : ''}
                  {t(`mcp.status.${server.status}`)}
                  {server.url ? ` · ${new URL(server.url).host}` : ''}
                  {server.tools.length ? ` · ${server.tools.length}` : ''}
                </small>
              </div>
              {server.status !== 'pending' && (
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t('mcp.enable', { name: server.name })}
                  checked={server.status === 'approved'}
                  disabled={busy}
                  onChange={(event) => void act(async () => replace(await api.setMcpServerEnabled(server.id, event.target.checked)))}
                />
              )}
              <button
                type="button"
                className={`settings-icon ${open === server.id ? 'active' : ''}`}
                aria-label={t('mcp.examine', { name: server.name })}
                title={t('mcp.examine', { name: server.name })}
                aria-expanded={open === server.id}
                disabled={busy}
                onClick={() => examine(server)}
              >
                <ListChecks size={13} />
              </button>
              <button
                type="button"
                className={`settings-icon ${armed === server.id ? 'armed' : ''}`}
                aria-label={t('mcp.delete', { name: server.name })}
                title={armed === server.id ? t('mcp.deleteConfirm') : t('common.delete')}
                onBlur={() => setArmed(null)}
                onClick={() => {
                  if (armed !== server.id) {
                    setArmed(server.id)
                    return
                  }
                  void act(async () => {
                    await api.deleteMcpServer(server.id)
                    setServers((current) => current.filter((item) => item.id !== server.id))
                    if (open === server.id) setOpen(null)
                  })
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>

            {open === server.id && (
              <div className="mcp-tools">
                {tools.map((tool) => {
                  const choice = choices[tool.name] ?? { selected: false, access: 'write' as const }
                  const set = (patch: Partial<Choice>) => setChoices((current) => ({ ...current, [tool.name]: { ...choice, ...patch } }))
                  return (
                    <div key={tool.name} className={`mcp-tool ${tool.supported ? '' : 'unsupported'}`}>
                      <label className="mcp-tool-name">
                        <input type="checkbox" checked={choice.selected} disabled={!tool.supported} onChange={(event) => set({ selected: event.target.checked })} />
                        <span>
                          {tool.title ?? tool.name}
                          {!tool.supported && <small> · {t('mcp.unsupported')}</small>}
                          {tool.readOnlyHint && <small> · {t('mcp.serverSaysRead')}</small>}
                        </span>
                      </label>
                      {/* Description du serveur : texte brut, c'est elle que l'empreinte fige. */}
                      {tool.description && <p className="mcp-tool-description">{tool.description}</p>}
                      {/* Paramètres : le modèle lit aussi leurs descriptions, l'admin doit les voir. */}
                      {Object.entries(tool.inputSchema.properties ?? {}).length > 0 && (
                        <ul className="mcp-tool-params">
                          {Object.entries(tool.inputSchema.properties ?? {}).map(([name, property]) => (
                            <li key={name}>
                              <code>{name}</code>
                              {typeof property?.description === 'string' && property.description ? ` — ${property.description}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                      <select
                        aria-label={tool.name}
                        value={choice.access}
                        disabled={!tool.supported || !choice.selected}
                        onChange={(event) => set({ access: event.target.value as Choice['access'] })}
                      >
                        <option value="read">{t('mcp.read')}</option>
                        <option value="write">{t('mcp.write')}</option>
                      </select>
                    </div>
                  )
                })}
                <button
                  type="button"
                  className="settings-save"
                  disabled={busy || !tools.some((tool) => tool.supported && choices[tool.name]?.selected)}
                  onClick={() => approve(server)}
                >
                  <Check size={14} />
                  {t('mcp.approve')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <form className="settings-invite mcp-add" onSubmit={add}>
        <input aria-label={t('mcp.name')} placeholder={t('mcp.name')} value={form.name} maxLength={60} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input type="url" aria-label="URL" placeholder={t('mcp.url')} value={form.url} maxLength={2000} onChange={(event) => setForm({ ...form, url: event.target.value })} />
        <div className="settings-segmented mcp-mode" role="radiogroup" aria-label={t('mcp.mode')}>
          {(['token', 'oauth', 'openapi'] as const).map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={form.mode === mode} onClick={() => setForm({ ...form, mode })}>
              {t(`mcp.mode.${mode}`)}
            </button>
          ))}
        </div>
        {form.mode === 'openapi' && (
          <label className="chat-actions-item mcp-spec">
            <FileJson size={14} />
            {spec ? spec.name : t('mcp.spec')}
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                if (file.size > 1024 * 1024) return onError(t('mcp.specTooLarge'))
                void file
                  .text()
                  .then((text) => setSpec({ name: file.name, value: JSON.parse(text) as Record<string, unknown> }))
                  .catch(() => onError(t('mcp.specInvalid')))
              }}
            />
          </label>
        )}
        {form.mode !== 'oauth' ? (
          <input
            type="password"
            autoComplete="off"
            aria-label={t('mcp.token')}
            placeholder={t('mcp.token')}
            value={form.token}
            maxLength={4000}
            onChange={(event) => setForm({ ...form, token: event.target.value })}
          />
        ) : (
          <>
            <input aria-label={t('mcp.clientId')} placeholder={t('mcp.clientId')} value={form.clientId} maxLength={500} onChange={(event) => setForm({ ...form, clientId: event.target.value })} />
            <input type="password" autoComplete="off" aria-label={t('mcp.clientSecret')} placeholder={t('mcp.clientSecret')} value={form.clientSecret} maxLength={4000} onChange={(event) => setForm({ ...form, clientSecret: event.target.value })} />
            <input aria-label={t('mcp.scope')} placeholder={t('mcp.scope')} value={form.scope} maxLength={500} onChange={(event) => setForm({ ...form, scope: event.target.value })} />
          </>
        )}
        <button
          type="submit"
          aria-label={t('mcp.add')}
          title={t('mcp.add')}
          disabled={busy || !form.name.trim() || !form.url.trim() || (form.mode === 'oauth' && !form.clientId.trim()) || (form.mode === 'openapi' && !spec)}
        >
          <Plus size={14} />
        </button>
      </form>
      <p className="settings-hint">{t('mcp.hint')}</p>
    </section>
  )
}
