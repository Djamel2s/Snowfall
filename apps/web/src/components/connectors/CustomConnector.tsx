import { useState, type FormEvent } from 'react'
import { ArrowLeft, FileJson, Plus } from 'lucide-react'
import { api, type McpServer } from '../../lib/api'
import { useI18n } from '../../lib/i18n'

type Kind = 'oauth' | 'token' | 'openapi'

/**
 * Connecteur personnalisé (absent du catalogue) : un serveur MCP, ou une API
 * décrite par sa spécification OpenAPI. Il suit ensuite le même parcours
 * qu'un connecteur du catalogue (connexion, choix des outils).
 */
export default function CustomConnector({ onBack, onCreated, onError }: { onBack: () => void; onCreated: (server: McpServer) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [kind, setKind] = useState<Kind>('oauth')
  const [form, setForm] = useState({ name: '', url: '', token: '', clientId: '', clientSecret: '', scope: '' })
  const [spec, setSpec] = useState<{ name: string; value: Record<string, unknown> } | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch })

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    onError('')
    try {
      const server = await api.createMcpServer({
        name: form.name.trim(),
        url: form.url.trim(),
        ...(kind === 'oauth'
          ? {
              // Vide : Snowfall s'enregistre chez l'éditeur s'il le permet (sinon l'API le dit).
              oauth: {
                ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
                ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
                ...(form.scope.trim() ? { scope: form.scope.trim() } : {}),
              },
            }
          : form.token.trim()
            ? { token: form.token.trim() }
            : {}),
        ...(kind === 'openapi' && spec ? { openapi: { spec: spec.value } } : {}),
      })
      onCreated(server)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="connector-detail" aria-label={t('connectors.custom')}>
      <button type="button" className="connector-back" onClick={onBack}>
        <ArrowLeft size={14} />
        {t('connectors.back')}
      </button>
      <h3>{t('connectors.custom')}</h3>
      <p className="settings-hint">{t('connectors.customHint')}</p>
      <form className="connector-form" aria-label={t('connectors.custom')} onSubmit={(event) => void submit(event)}>
        <input required aria-label={t('mcp.name')} placeholder={t('mcp.name')} value={form.name} maxLength={60} onChange={(event) => set({ name: event.target.value })} />
        <input required type="url" aria-label={t('connectors.url')} placeholder={kind === 'openapi' ? t('connectors.urlApi') : t('connectors.url')} value={form.url} maxLength={2000} onChange={(event) => set({ url: event.target.value })} />
        <div className="tool-modes" role="radiogroup" aria-label={t('mcp.mode')}>
          {(['oauth', 'token', 'openapi'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => setKind(value)}>
              <span>
                <strong>{t(`connectors.kind.${value}`)}</strong>
                <small>{t(`connectors.kind.${value}Hint`)}</small>
              </span>
            </button>
          ))}
        </div>
        {kind === 'oauth' ? (
          <details className="connector-advanced">
            <summary>{t('connectors.oauthAdvanced')}</summary>
            <input aria-label={t('mcp.clientId')} placeholder={t('connectors.clientIdOptional')} value={form.clientId} maxLength={500} onChange={(event) => set({ clientId: event.target.value })} />
            <input type="password" autoComplete="off" aria-label={t('mcp.clientSecret')} placeholder={t('mcp.clientSecret')} value={form.clientSecret} maxLength={4000} onChange={(event) => set({ clientSecret: event.target.value })} />
            <input aria-label={t('mcp.scope')} placeholder={t('mcp.scope')} value={form.scope} maxLength={500} onChange={(event) => set({ scope: event.target.value })} />
          </details>
        ) : (
          <input type="password" autoComplete="off" aria-label={t('mcp.token')} placeholder={t('mcp.token')} value={form.token} maxLength={4000} onChange={(event) => set({ token: event.target.value })} />
        )}
        {kind === 'openapi' && (
          <label className="settings-secondary mcp-spec">
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
        <button type="submit" className="settings-save connector-primary" disabled={busy || !form.name.trim() || !form.url.trim() || (kind === 'openapi' && !spec)}>
          <Plus size={14} />
          {t('connectors.addCustom')}
        </button>
      </form>
    </section>
  )
}
