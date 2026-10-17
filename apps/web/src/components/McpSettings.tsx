import { useEffect, useState, type FormEvent } from 'react'
import { Check, ListChecks, Plus, Trash2 } from 'lucide-react'
import { api, type McpDiscoveredTool, type McpServer } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Choice = { selected: boolean; access: 'read' | 'write' }

/**
 * Serveurs MCP de l'organisation (administrateurs) : ajout, examen des outils
 * publiés, approbation outil par outil (lecture ou écriture), suspension.
 */
export default function McpSettings({ onError }: { onError: (message: string) => void }) {
  const { t } = useI18n()
  const [servers, setServers] = useState<McpServer[]>([])
  const [form, setForm] = useState({ name: '', url: '', token: '' })
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
      const server = await api.createMcpServer({ name: form.name.trim(), url: form.url.trim(), ...(form.token.trim() ? { token: form.token.trim() } : {}) })
      setServers((current) => [...current, server])
      setForm({ name: '', url: '', token: '' })
    })
  }

  function examine(server: McpServer) {
    if (open === server.id) {
      setOpen(null)
      return
    }
    void act(async () => {
      const discovered = await api.discoverMcpTools(server.id)
      setTools(discovered)
      // Par défaut : rien de coché ; écriture, sauf outil déjà approuvé en lecture.
      setChoices(
        Object.fromEntries(
          discovered.map((tool) => {
            const approved = server.tools.find((item) => item.name === tool.name)
            return [tool.name, { selected: Boolean(approved), access: approved?.access ?? 'write' }]
          }),
        ),
      )
      setOpen(server.id)
    })
  }

  function approve(server: McpServer) {
    const selected = tools.filter((tool) => tool.supported && choices[tool.name]?.selected)
    void act(async () => {
      replace(await api.approveMcpServer(server.id, selected.map((tool) => ({ name: tool.name, access: choices[tool.name]!.access }))))
      setOpen(null)
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
        <input
          type="password"
          autoComplete="off"
          aria-label={t('mcp.token')}
          placeholder={t('mcp.token')}
          value={form.token}
          maxLength={4000}
          onChange={(event) => setForm({ ...form, token: event.target.value })}
        />
        <button type="submit" aria-label={t('mcp.add')} title={t('mcp.add')} disabled={busy || !form.name.trim() || !form.url.trim()}>
          <Plus size={14} />
        </button>
      </form>
      <p className="settings-hint">{t('mcp.hint')}</p>
    </section>
  )
}
