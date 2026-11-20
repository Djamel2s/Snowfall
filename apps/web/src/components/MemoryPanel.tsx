import { useEffect, useState } from 'react'
import { Brain, Trash2 } from 'lucide-react'
import { api, type UserMemory } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { ListEmpty, ListRow, ListRows, ListSection, PanelSearch, RowAction, SectionAction } from './ui/List'

type Props = {
  enabled: boolean
  onToggle: (enabled: boolean) => void
  onError: (message: string) => void
}

/**
 * Mémoire (barre latérale) : désactivée par défaut. Activée, l'assistant retient
 * ce que l'utilisateur lui demande, après validation ; tout reste visible et
 * effaçable ici. Même format que les autres panneaux : recherche, puis la liste.
 */
export default function MemoryPanel({ enabled, onToggle, onError }: Props) {
  const { t } = useI18n()
  const [memories, setMemories] = useState<UserMemory[] | null>(null)
  const [query, setQuery] = useState('')
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .listMemories()
      .then((items) => !cancelled && setMemories(items))
      .catch(() => !cancelled && setMemories([]))
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

  const needle = query.trim().toLocaleLowerCase()
  const shown = (memories ?? []).filter((item) => !needle || item.content.toLocaleLowerCase().includes(needle))

  return (
    <div className="list-panel memory-panel">
      <label className="settings-row settings-switch">
        <span>
          {t('memory.enable')}
          <small>{t('memory.hint')}</small>
        </span>
        <input type="checkbox" role="switch" checked={enabled} onChange={(event) => onToggle(event.target.checked)} />
      </label>
      <PanelSearch value={query} onChange={setQuery} placeholder={t('memory.search')} />

      <ListSection
        label={t('memory.listTitle')}
        actions={
          memories?.length ? (
            <SectionAction label={armed ? t('memory.clearConfirm') : t('memory.clear')} pressed={armed} onClick={() => void clear()}>
              <Trash2 size={14} />
            </SectionAction>
          ) : undefined
        }
      >
        {memories === null ? (
          <ListEmpty>{t('common.loading')}</ListEmpty>
        ) : shown.length ? (
          <ListRows>
            {shown.map((memory) => (
              <ListRow
                key={memory.id}
                icon={<Brain size={15} />}
                title={memory.content}
                tooltip={memory.content}
                actions={
                  <RowAction label={t('memory.delete', { text: memory.content.slice(0, 40) })} title={t('common.delete')} onClick={() => void remove(memory.id)}>
                    <Trash2 size={12} />
                  </RowAction>
                }
              />
            ))}
          </ListRows>
        ) : (
          <ListEmpty>{needle ? t('memory.noMatch') : t('memory.empty')}</ListEmpty>
        )}
      </ListSection>
    </div>
  )
}
