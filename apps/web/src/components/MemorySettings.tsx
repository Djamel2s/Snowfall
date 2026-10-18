import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { api, type UserMemory } from '../lib/api'
import { useI18n } from '../lib/i18n'

/**
 * Mémoire (Mon compte) : désactivée par défaut. Activée, l'assistant retient ce
 * que l'utilisateur lui demande, après validation ; tout reste visible et effaçable ici.
 */
export default function MemorySettings({ enabled, onToggle, onError }: { enabled: boolean; onToggle: (enabled: boolean) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [memories, setMemories] = useState<UserMemory[] | null>(null)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.listMemories().then((items) => !cancelled && setMemories(items)).catch(() => !cancelled && setMemories([]))
    return () => {
      cancelled = true
    }
  }, [])

  async function remove(id: string) {
    try {
      await api.deleteMemory(id)
      setMemories((current) => current?.filter((item) => item.id !== id) ?? null)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function clear() {
    if (!armed) return setArmed(true)
    try {
      await api.clearMemories()
      setMemories([])
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArmed(false)
    }
  }

  return (
    <section className="settings-card" aria-label={t('memory.title')}>
      <h3>{t('memory.title')}</h3>
      <label className="settings-row settings-switch">
        <span>
          {t('memory.enable')}
          <small>{t('memory.hint')}</small>
        </span>
        <input type="checkbox" role="switch" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
      </label>
      {memories && memories.length > 0 && (
        <>
          <ul className="memory-list">
            {memories.map((memory) => (
              <li key={memory.id}>
                <span>{memory.content}</span>
                <button type="button" aria-label={t('memory.delete', { text: memory.content.slice(0, 40) })} title={t('common.delete')} onClick={() => void remove(memory.id)}>
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={`chat-actions-item${armed ? ' armed' : ''}`} onBlur={() => setArmed(false)} onClick={() => void clear()}>
            <Trash2 size={14} />
            {armed ? t('memory.clearConfirm') : t('memory.clear')}
          </button>
        </>
      )}
      {memories?.length === 0 && enabled && <p className="settings-hint">{t('memory.empty')}</p>}
    </section>
  )
}
