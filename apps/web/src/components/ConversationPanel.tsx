import { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Check, Trash2, X } from 'lucide-react'
import { api, type AttachmentMeta, type ConversationSettings, type Preset } from '../lib/api'
import MyFiles from './MyFiles'
import { useI18n } from '../lib/i18n'

type Props = {
  conversation: { id: string; settings?: ConversationSettings; tags?: string[]; archived?: boolean }
  canWrite: boolean
  onSettingsSaved: (settings: ConversationSettings | undefined) => void
  /** Étiquettes ou archive enregistrées. */
  onFilingSaved: (filing: { tags: string[]; archived: boolean }) => void
  /** Fichier déjà envoyé, joint à cette conversation (copie). */
  onFileAttached: (attachment: AttachmentMeta, sensitive: boolean) => void
  onClose: () => void
  onError: (message: string) => void
}

const creativities = [undefined, 'precise', 'balanced', 'creative'] as const
const lengths = [undefined, 'complete', 'concise'] as const

/** Réglages sans champ vide : deux réglages équivalents se comparent à l'identique. */
function clean(settings: ConversationSettings): ConversationSettings {
  return {
    ...(settings.creativity ? { creativity: settings.creativity } : {}),
    ...(settings.length ? { length: settings.length } : {}),
    ...(settings.instructions?.trim() ? { instructions: settings.instructions.trim() } : {}),
  }
}

const same = (a: ConversationSettings, b: ConversationSettings) => JSON.stringify(clean(a)) === JSON.stringify(clean(b))

/**
 * « Cette conversation » : ses réglages (priment sur ceux de l'agent) et les
 * préréglages de l'utilisateur. Dans la barre latérale, comme le reste.
 */
const MAX_TAGS = 10

export default function ConversationPanel({ conversation, canWrite, onSettingsSaved, onFilingSaved, onFileAttached, onClose, onError }: Props) {
  const { t } = useI18n()
  const saved = conversation.settings ?? {}
  const [draft, setDraft] = useState<ConversationSettings>(saved)
  const [presets, setPresets] = useState<Preset[]>([])
  const [presetName, setPresetName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [tagDraft, setTagDraft] = useState('')
  const tags = conversation.tags ?? []

  useEffect(() => {
    let cancelled = false
    api
      .listPresets()
      .then((items) => !cancelled && setPresets(items))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  async function save(next: ConversationSettings) {
    setBusy(true)
    try {
      const updated = await api.updateConversation(conversation.id, { settings: clean(next) })
      setDraft(updated.settings ?? {})
      onSettingsSaved(updated.settings)
      setDone(true)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t('error.send'))
    } finally {
      setBusy(false)
    }
  }

  async function file(changes: { tags?: string[]; archived?: boolean }) {
    setBusy(true)
    try {
      const updated = await api.updateConversation(conversation.id, changes)
      onFilingSaved({ tags: updated.tags ?? [], archived: Boolean(updated.archived) })
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t('error.send'))
    } finally {
      setBusy(false)
    }
  }

  function addTag() {
    const tag = tagDraft.trim()
    if (!tag) return
    setTagDraft('')
    if (tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) return
    void file({ tags: [...tags, tag] })
  }

  async function savePreset() {
    setBusy(true)
    try {
      const preset = await api.createPreset(presetName.trim(), clean(draft))
      setPresets((current) => [...current, preset])
      setPresetName('')
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t('error.send'))
    } finally {
      setBusy(false)
    }
  }

  async function removePreset(id: string) {
    try {
      await api.deletePreset(id)
      setPresets((current) => current.filter((preset) => preset.id !== id))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t('error.send'))
    }
  }

  const change = (next: ConversationSettings) => {
    setDraft(next)
    setDone(false)
  }

  return (
    <div className="settings-panel conversation-panel">
      <div className="sidebar-section-label projects-heading">
        <span>{t('conversationPanel.title').toUpperCase()}</span>
        <button className="projects-add-button" type="button" aria-label={t('conversationPanel.close')} title={t('conversationPanel.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <section className="settings-card" aria-label={t('conversationPanel.settings')}>
        <h3>{t('conversationPanel.settings')}</h3>
        <div className="settings-row">
          <span>{t('studio.creativity')}</span>
        </div>
        <div className="settings-segmented" role="radiogroup" aria-label={t('studio.creativity')}>
          {creativities.map((value) => (
            <button
              key={value ?? 'auto'}
              type="button"
              role="radio"
              disabled={!canWrite}
              aria-checked={draft.creativity === value}
              onClick={() => change({ ...draft, creativity: value })}
            >
              {value ? t(`studio.creativity.${value}`) : t('conversationPanel.agentDefault')}
            </button>
          ))}
        </div>
        <div className="settings-row">
          <span>{t('studio.length')}</span>
        </div>
        <div className="settings-segmented" role="radiogroup" aria-label={t('studio.length')}>
          {lengths.map((value) => (
            <button
              key={value ?? 'auto'}
              type="button"
              role="radio"
              disabled={!canWrite}
              aria-checked={draft.length === value}
              onClick={() => change({ ...draft, length: value })}
            >
              {value ? t(`studio.length.${value}`) : t('conversationPanel.agentDefault')}
            </button>
          ))}
        </div>
        <textarea
          className="settings-workshop-input"
          rows={3}
          maxLength={1500}
          disabled={!canWrite}
          value={draft.instructions ?? ''}
          placeholder={t('conversationPanel.instructions')}
          aria-label={t('conversationPanel.instructions')}
          onChange={(event) => change({ ...draft, instructions: event.target.value })}
        />
        {canWrite && (
          <button type="button" className="settings-save" disabled={busy || same(draft, saved)} onClick={() => void save(draft)}>
            <Check size={14} />
            {done && same(draft, saved) ? t('settings.saved') : t('common.save')}
          </button>
        )}
      </section>

      <section className="settings-card" aria-label={t('filing.title')}>
        <h3>{t('filing.title')}</h3>
        {tags.length > 0 && (
          <ul className="tag-list">
            {tags.map((tag) => (
              <li key={tag} className="sidebar-tag">
                {tag}
                {canWrite && (
                  <button type="button" aria-label={t('tags.remove', { name: tag })} title={t('common.delete')} disabled={busy} onClick={() => void file({ tags: tags.filter((item) => item !== tag) })}>
                    <X size={11} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && tags.length < MAX_TAGS && (
          <form
            className="preset-form"
            onSubmit={(event) => {
              event.preventDefault()
              addTag()
            }}
          >
            <input value={tagDraft} maxLength={30} placeholder={t('tags.add')} aria-label={t('tags.add')} onChange={(event) => setTagDraft(event.target.value)} />
            <button type="submit" className="settings-save" disabled={busy || !tagDraft.trim()}>
              {t('presets.save')}
            </button>
          </form>
        )}
        {canWrite && (
          <button type="button" className="settings-secondary" disabled={busy} onClick={() => void file({ archived: !conversation.archived })}>
            {conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            {conversation.archived ? t('archive.restore') : t('archive.archive')}
          </button>
        )}
      </section>

      <MyFiles conversationId={conversation.id} canWrite={canWrite} onAttached={onFileAttached} onError={onError} />

      <section className="settings-card" aria-label={t('presets.title')}>
        <h3>{t('presets.title')}</h3>
        {presets.length === 0 && <p className="settings-hint">{t('presets.empty')}</p>}
        <ul className="preset-list">
          {presets.map((preset) => (
            <li key={preset.id}>
              <button type="button" className="preset-apply" disabled={!canWrite || busy} title={t('presets.apply')} onClick={() => void save(preset.settings)}>
                {preset.name}
              </button>
              {canWrite && (
                <button type="button" className="icon-button preset-delete" aria-label={t('presets.delete', { name: preset.name })} title={t('common.delete')} onClick={() => void removePreset(preset.id)}>
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {canWrite && (
          <form
            className="preset-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (presetName.trim()) void savePreset()
            }}
          >
            <input value={presetName} maxLength={40} placeholder={t('presets.name')} aria-label={t('presets.name')} onChange={(event) => setPresetName(event.target.value)} />
            <button type="submit" className="settings-save" disabled={busy || !presetName.trim()}>
              {t('presets.save')}
            </button>
          </form>
        )}
      </section>
    </div>
  )
}
