import { useEffect, useState } from 'react'
import { Link2, Unlink } from 'lucide-react'
import { api, type McpConnection } from '../lib/api'
import { useI18n } from '../lib/i18n'

/**
 * Connexions personnelles aux outils externes (serveurs MCP en mode OAuth) :
 * chacun se connecte avec son propre compte, les actions lui sont attribuées.
 * Absente tant qu'aucun serveur de ce type n'existe.
 */
export default function McpConnections({ notice, onError }: { notice?: string | undefined; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [connections, setConnections] = useState<McpConnection[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.listMcpConnections().then((items) => !cancelled && setConnections(items)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [notice])

  async function connect(id: string) {
    setBusy(id)
    try {
      // Le fournisseur reviendra sur /mcp/callback (state et PKCE gardés côté serveur).
      window.location.assign(await api.connectMcp(id))
    } catch (cause) {
      setBusy(null)
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function disconnect(id: string) {
    setBusy(id)
    try {
      await api.disconnectMcp(id)
      setConnections((current) => current.map((item) => (item.id === id ? { ...item, connected: false } : item)))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  if (connections.length === 0) return null
  return (
    <section className="settings-card" aria-label={t('connections.title')}>
      <h3>{t('connections.title')}</h3>
      {notice && <p className="settings-hint connections-notice" role="status">{notice}</p>}
      <ul className="connections-list">
        {connections.map((item) => (
          <li key={item.id}>
            <span>
              <strong>{item.name}</strong>
              <small>{item.connected ? t('connections.connected') : t('connections.disconnected')}</small>
            </span>
            {item.connected ? (
              <button type="button" className="chat-actions-item" disabled={busy === item.id} onClick={() => void disconnect(item.id)} aria-label={t('connections.disconnect', { name: item.name })}>
                <Unlink size={14} />
                {t('connections.disconnectShort')}
              </button>
            ) : (
              <button type="button" className="chat-actions-primary" disabled={busy === item.id} onClick={() => void connect(item.id)} aria-label={t('connections.connect', { name: item.name })}>
                <Link2 size={14} />
                {t('connections.connectShort')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="settings-hint">{t('connections.hint')}</p>
    </section>
  )
}
