import { useEffect, useState } from 'react'
import { ArrowLeft, Check, Link2, LoaderCircle, Pencil, Trash2, Unlink } from 'lucide-react'
import { api, ApiError, type CatalogConnector, type McpDiscoveredTool, type McpServer } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import ConnectorLogo from '../ConnectorLogo'
import ToolPicker from './ToolPicker'
import { defaultAccess, initialMode, presetChoices, type ToolChoices } from './tool-choices'

type Props = {
  server: McpServer
  entry: CatalogConnector | undefined
  isAdmin: boolean
  connected: boolean
  onBack: () => void
  onChanged: (server: McpServer | null) => void
  onConnectedChange: (connected: boolean) => void
  onError: (message: string) => void
}

const host = (url?: string) => {
  try {
    return url ? new URL(url).host : ''
  } catch {
    return ''
  }
}

/**
 * Fiche d'un connecteur : où il en est, et UNE action principale à la fois.
 * Administrateur : ajouté → connexion avec son compte (si OAuth) → outils
 * choisis → prêt. Membre : se connecter / se déconnecter.
 */
export default function ConnectorDetail({ server, entry, isAdmin, connected, onBack, onChanged, onConnectedChange, onError }: Props) {
  const { t } = useI18n()
  const [tools, setTools] = useState<McpDiscoveredTool[] | null>(null)
  const [mode, setMode] = useState<'read' | 'all' | 'custom'>('read')
  const [choices, setChoices] = useState<ToolChoices>({})
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const oauth = server.auth === 'oauth'
  const needsLogin = oauth && !connected
  const pending = server.status === 'pending'
  // Choisir les outils : l'administrateur, une fois connecté (OAuth : avec son compte).
  const choosing = isAdmin && !needsLogin && (pending || editing)

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

  async function loadTools() {
    applyTools(await api.discoverMcpTools(server.id))
  }

  function applyTools(discovered: McpDiscoveredTool[]) {
    const start = initialMode(discovered, server.tools)
    setTools(discovered)
    setMode(start)
    setChoices(
      start === 'custom'
        ? Object.fromEntries(
            discovered.map((tool) => {
              const approved = server.tools.find((item) => item.name === tool.name)
              return [tool.name, { selected: Boolean(approved), access: approved?.access ?? defaultAccess(tool) }]
            }),
          )
        : presetChoices(discovered, start),
    )
  }

  // Outils lus d'eux-mêmes dès qu'il faut les choisir (pas de second clic).
  useEffect(() => {
    if (!choosing || tools || loadFailed) return
    let cancelled = false
    api
      .discoverMcpTools(server.id)
      .then((discovered) => !cancelled && applyTools(discovered))
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadFailed(true)
        onError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choosing, server.id, loadFailed])

  const connect = () => act(async () => window.location.assign(await api.connectMcp(server.id)))

  function approve() {
    const selected = (tools ?? []).filter((tool) => tool.supported && choices[tool.name]?.selected)
    void act(async () => {
      try {
        onChanged(await api.approveMcpServer(server.id, selected.map((tool) => ({ name: tool.name, access: choices[tool.name]!.access, fingerprint: tool.fingerprint }))))
        setEditing(false)
        setTools(null)
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 409)) throw cause
        // L'éditeur a changé un outil pendant le choix : nouvelle version à relire.
        await loadTools()
        onError(t('mcp.changed'))
      }
    })
  }

  const steps = [
    { key: 'added', label: t('connectors.step.added'), done: true },
    ...(oauth ? [{ key: 'login', label: t('connectors.step.login'), done: connected }] : []),
    { key: 'tools', label: t('connectors.step.tools'), done: !pending },
    { key: 'ready', label: t('connectors.step.ready'), done: server.status === 'approved' && (!oauth || connected) },
  ]
  const current = steps.find((step) => !step.done)?.key
  const selectedCount = (tools ?? []).filter((tool) => tool.supported && choices[tool.name]?.selected).length

  return (
    <section className="connector-detail" aria-label={server.name}>
      <button type="button" className="connector-back" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('connectors.back')}
      </button>

      <header className="connector-detail-head">
        <ConnectorLogo icon={entry?.icon ?? null} color={entry?.color ?? '#475569'} name={server.name} size={44} />
        <div>
          <h3>{server.name}</h3>
          <p>{entry?.description ?? host(server.url)}</p>
        </div>
      </header>

      {isAdmin && (
        <ol className="connector-steps" aria-label={t('connectors.progress')}>
          {steps.map((step, index) => (
            <li key={step.key} className={step.done ? 'done' : step.key === current ? 'current' : ''} aria-current={step.key === current ? 'step' : undefined}>
              <span>{step.done ? <Check size={11} /> : index + 1}</span>
              {step.label}
            </li>
          ))}
        </ol>
      )}

      {/* Une seule action principale, selon l'étape. */}
      {server.status === 'disabled' ? (
        <p className="connector-state">{t('connectors.state.disabled')}</p>
      ) : needsLogin ? (
        <div className="connector-action">
          <p>{isAdmin && pending ? t('connectors.state.loginAdmin', { name: server.name }) : t('connectors.state.login', { name: server.name })}</p>
          <button type="button" className="settings-save connector-primary" disabled={busy} onClick={() => void connect()}>
            <Link2 size={14} />
            {t('connectors.connectNamed', { name: server.name })}
          </button>
        </div>
      ) : choosing ? (
        <div className="connector-action">
          <p>{t('connectors.state.tools')}</p>
          {!tools ? (
            loadFailed ? (
              <button type="button" className="settings-secondary" onClick={() => setLoadFailed(false)}>
                {t('common.retry')}
              </button>
            ) : (
              <p className="settings-hint">
                <LoaderCircle size={12} className="spin" /> {t('connectors.loadingTools')}
              </p>
            )
          ) : tools.length === 0 ? (
            <p className="settings-hint">{t('connectors.noTools')}</p>
          ) : (
            <>
              <ToolPicker
                tools={tools}
                choices={choices}
                mode={mode}
                onChange={(next) => {
                  setMode(next.mode)
                  setChoices(next.choices)
                }}
              />
              <button type="button" className="settings-save connector-primary" disabled={busy || selectedCount === 0} onClick={approve}>
                <Check size={14} />
                {pending ? t('connectors.activate', { count: selectedCount }) : t('connectors.saveTools', { count: selectedCount })}
              </button>
            </>
          )}
          {editing && (
            <button type="button" className="settings-secondary" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </button>
          )}
        </div>
      ) : pending ? (
        <p className="connector-state">{t('connectors.state.waitingAdmin')}</p>
      ) : (
        <div className="connector-action">
          <p className="connector-ready-line">
            <Check size={14} />
            {oauth ? t('connectors.state.readyConnected') : t('connectors.state.ready')}
          </p>
          <p className="settings-hint">{t('connectors.state.readyHint', { count: server.tools.length })}</p>
          {oauth && (
            <button
              type="button"
              className="settings-secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.disconnectMcp(server.id)
                  onConnectedChange(false)
                })
              }
            >
              <Unlink size={13} />
              {t('connectors.disconnectNamed', { name: server.name })}
            </button>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="connector-admin">
          {!pending && !editing && server.status !== 'disabled' && (!oauth || connected) && (
            <button type="button" className="settings-secondary" onClick={() => setEditing(true)}>
              <Pencil size={13} />
              {t('connectors.editTools')}
            </button>
          )}
          {!pending && (
            <label className="settings-row settings-switch">
              <span>{t('connectors.enabled')}</span>
              <input
                type="checkbox"
                role="switch"
                aria-label={t('mcp.enable', { name: server.name })}
                checked={server.status === 'approved'}
                disabled={busy}
                onChange={(event) => void act(async () => onChanged(await api.setMcpServerEnabled(server.id, event.target.checked)))}
              />
            </label>
          )}
          <button
            type="button"
            className={`settings-secondary connector-delete${armed ? ' armed' : ''}`}
            aria-label={armed ? t('connectors.confirmDelete', { name: server.name }) : t('mcp.delete', { name: server.name })}
            onBlur={() => setArmed(false)}
            onClick={() => {
              if (!armed) return setArmed(true)
              void act(async () => {
                await api.deleteMcpServer(server.id)
                onChanged(null)
              })
            }}
          >
            <Trash2 size={13} />
            {armed ? t('connectors.confirmDeleteShort') : t('common.delete')}
          </button>
          <p className="settings-hint">{t('connectors.address', { host: host(server.url) })}</p>
        </div>
      )}
    </section>
  )
}
