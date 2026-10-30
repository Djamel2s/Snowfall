import { useState, type FormEvent } from 'react'
import { Check, Pencil, ScrollText, Share2, Trash2, Users, X } from 'lucide-react'
import SharePanel from './SharePanel'
import { api, type Prompt } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { promptVariables } from '../lib/prompts'
import { ListEmpty, ListRow, ListRows, ListSection, PanelNew, PanelSearch, RowAction } from './ui/List'

type Draft = { id?: string; name: string; content: string }

type Props = {
  prompts: Prompt[]
  canWrite: boolean
  onChange: (prompts: Prompt[]) => void
  onUse: (prompt: Prompt) => void
}

/**
 * Bibliothèque de prompts (barre latérale) : les miens et ceux partagés par
 * l'organisation. Créer, modifier, partager ; cliquer remplit la zone de
 * saisie. Dans la conversation, « / » les propose aussi.
 */
export default function PromptLibrary({ prompts, canWrite, onChange, onUse }: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  // Partage ouvert sous ce prompt (un seul à la fois).
  const [sharing, setSharing] = useState<string | null>(null)

  const needle = query.trim().toLocaleLowerCase()
  const shown = needle ? prompts.filter((prompt) => `${prompt.name} ${prompt.content}`.toLocaleLowerCase().includes(needle)) : prompts

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || !draft.name.trim() || !draft.content.trim()) return
    setError('')
    try {
      const input = { name: draft.name.trim(), content: draft.content.trim() }
      const saved = draft.id ? await api.updatePrompt(draft.id, input) : await api.createPrompt(input)
      onChange(draft.id ? prompts.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...prompts])
      setDraft(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function remove(prompt: Prompt) {
    if (armed !== prompt.id) return setArmed(prompt.id)
    try {
      await api.deletePrompt(prompt.id)
      onChange(prompts.filter((item) => item.id !== prompt.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="list-panel prompt-library">
      {canWrite && <PanelNew label={t('prompts.new')} disabled={Boolean(draft)} onClick={() => setDraft({ name: '', content: '' })} />}
      <PanelSearch value={query} onChange={setQuery} placeholder={t('prompts.search')} />
      {error && <p className="settings-error" role="alert">{error}</p>}

      {draft && (
        <form className="prompt-form" aria-label={draft.id ? t('prompts.edit') : t('prompts.new')} onSubmit={(event) => void save(event)}>
          <input autoFocus placeholder={t('prompts.name')} aria-label={t('prompts.name')} value={draft.name} maxLength={60} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <textarea placeholder={t('prompts.content')} aria-label={t('prompts.content')} rows={6} value={draft.content} maxLength={8000} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
          <p className="settings-hint">
            {promptVariables(draft.content).length ? t('prompts.variables', { list: promptVariables(draft.content).join(', ') }) : t('prompts.variablesHint')}
          </p>
          <div className="prompt-form-actions">
            <button type="button" className="chat-actions-item" onClick={() => setDraft(null)}>
              <X size={14} />
              {t('common.cancel')}
            </button>
            <button type="submit" className="chat-actions-primary" disabled={!draft.name.trim() || !draft.content.trim()}>
              <Check size={14} />
              {t('common.save')}
            </button>
          </div>
        </form>
      )}

      <ListSection label={t('prompts.title')}>
        {prompts.length === 0 && !draft ? (
          <ListEmpty>{t('prompts.empty')}</ListEmpty>
        ) : shown.length === 0 ? (
          <ListEmpty>{t('prompts.noMatch')}</ListEmpty>
        ) : (
          <ListRows>
            {shown.map((prompt) => (
              <ListRow
                key={prompt.id}
                icon={<ScrollText size={15} />}
                title={
                  <>
                    {prompt.name}
                    {prompt.shared && <Users size={11} aria-label={t('prompts.shared')} />}
                  </>
                }
                subtitle={prompt.content.replace(/\s+/g, ' ').slice(0, 80)}
                tooltip={t('prompts.use')}
                onClick={() => onUse(prompt)}
                actions={
                  prompt.canEdit && canWrite ? (
                    <>
                      <RowAction label={t('prompts.editNamed', { name: prompt.name })} title={t('common.edit')} onClick={() => setDraft({ id: prompt.id, name: prompt.name, content: prompt.content })}>
                        <Pencil size={12} />
                      </RowAction>
                      {prompt.mine && (
                        <RowAction label={t('share.openNamed', { name: prompt.name })} title={t('share.access')} expanded={sharing === prompt.id} onClick={() => setSharing(sharing === prompt.id ? null : prompt.id)}>
                          <Share2 size={12} />
                        </RowAction>
                      )}
                      {prompt.mine && (
                        <RowAction
                          label={t('prompts.delete', { name: prompt.name })}
                          title={armed === prompt.id ? t('prompts.deleteConfirm') : t('common.delete')}
                          armed={armed === prompt.id}
                          onBlur={() => setArmed(null)}
                          onClick={() => void remove(prompt)}
                        >
                          <Trash2 size={12} />
                        </RowAction>
                      )}
                    </>
                  ) : undefined
                }
              >
                {sharing === prompt.id && (
                  <div className="list-row-expanded">
                    <SharePanel resource={{ type: 'prompt', id: prompt.id, name: prompt.name }} onError={setError} />
                  </div>
                )}
              </ListRow>
            ))}
          </ListRows>
        )}
      </ListSection>
      <p className="settings-hint prompt-library-hint">{t('prompts.slashHint')}</p>
    </div>
  )
}
