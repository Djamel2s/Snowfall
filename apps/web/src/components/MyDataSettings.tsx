import { useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { api } from '../lib/api'
import { downloadText } from '../lib/export'
import { useI18n } from '../lib/i18n'

const MAX_BYTES = 25 * 1024 * 1024

/**
 * Mes données : importer des conversations (ChatGPT, LibreChat, Snowfall) et
 * exporter tout ce que la plateforme conserve sur moi (droit d'accès RGPD).
 */
export default function MyDataSettings({ onImported, onError }: { onImported: () => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const file = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  async function importFile(selected: File | undefined) {
    if (!selected) return
    setStatus('')
    onError('')
    if (selected.size > MAX_BYTES) return onError(t('data.tooLarge'))
    setBusy(true)
    try {
      const result = await api.importConversations(JSON.parse(await selected.text()) as unknown)
      setStatus(t('data.imported', { count: result.imported }))
      onImported()
    } catch (cause) {
      onError(cause instanceof SyntaxError ? t('data.invalid') : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function exportAll() {
    setBusy(true)
    try {
      downloadText(JSON.stringify(await api.exportPersonalData(), null, 2), 'application/json', 'mes-donnees-snowfall.json')
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-card" aria-label={t('data.title')}>
      <h3>{t('data.title')}</h3>
      <div className="chat-actions-row">
        <button type="button" className="chat-actions-item" disabled={busy} onClick={() => file.current?.click()}>
          <Upload size={14} />
          {t('data.import')}
        </button>
        <button type="button" className="chat-actions-item" disabled={busy} onClick={() => void exportAll()}>
          <Download size={14} />
          {t('data.export')}
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            void importFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </div>
      <p className="settings-hint">{status || t('data.hint')}</p>
    </section>
  )
}
