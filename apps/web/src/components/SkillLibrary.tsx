import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, FileCode, FileText, FileUp, GraduationCap, Lock, Paperclip, Pencil, Plus, Share2, Trash2, Users, X } from 'lucide-react'
import { api, type Skill, type SkillInput } from '../lib/api'
import { formatSize } from '../lib/format'
import { useI18n } from '../lib/i18n'
import SharePanel from './SharePanel'

type Draft = SkillInput & { id?: string }

const empty: Draft = { name: '', description: '', instructions: '', confidential: false }

/**
 * Compétences (barre latérale) : savoir-faire que les agents chargent à la
 * demande. Le modèle lit d'abord la description (quand s'en servir), puis les
 * instructions et les fichiers seulement s'il en a besoin.
 */
export default function SkillLibrary({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n()
  const [skills, setSkills] = useState<Skill[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [error, setError] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  // Import d'un dossier zippé (format Anthropic : SKILL.md + références).
  const zipInput = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importConfidential, setImportConfidential] = useState(false)
  const [importNote, setImportNote] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .listSkills()
      .then((items) => !cancelled && setSkills(items))
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [])

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))
  const replace = (skill: Skill) => setSkills((current) => current.map((item) => (item.id === skill.id ? skill : item)))

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!draft || !draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()) return
    setError('')
    try {
      const input = { name: draft.name.trim(), description: draft.description.trim(), instructions: draft.instructions.trim(), confidential: draft.confidential }
      const saved = draft.id ? await api.updateSkill(draft.id, input) : await api.createSkill(input)
      setSkills((current) => (draft.id ? current.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...current]))
      setDraft(null)
      setOpen(saved.id)
    } catch (cause) {
      fail(cause)
    }
  }

  async function remove(skill: Skill) {
    if (armed !== skill.id) return setArmed(skill.id)
    try {
      await api.deleteSkill(skill.id)
      setSkills((current) => current.filter((item) => item.id !== skill.id))
    } catch (cause) {
      fail(cause)
    }
  }

  async function upload(skill: Skill, files: FileList | null) {
    setError('')
    for (const file of [...(files ?? [])]) {
      try {
        const saved = await api.uploadSkillFile(skill.id, file, file.name)
        setSkills((current) => current.map((item) => (item.id === skill.id ? { ...item, files: [...item.files, saved] } : item)))
      } catch (cause) {
        fail(cause)
      }
    }
    if (fileInput.current) fileInput.current.value = ''
  }

  async function importZip(files: FileList | null) {
    const file = files?.[0]
    if (zipInput.current) zipInput.current.value = ''
    if (!file) return
    setError('')
    setImportNote('')
    try {
      const { skill, skipped } = await api.importSkill(file, importConfidential)
      setSkills((current) => [skill, ...current])
      setOpen(skill.id)
      setImporting(false)
      if (skipped.length) setImportNote(t('skills.importSkipped', { list: skipped.map((item) => `${item.name} (${t(`skills.skip.${item.reason}`)})`).join(', ') }))
    } catch (cause) {
      fail(cause)
    }
  }

  async function removeFile(skill: Skill, fileId: string) {
    try {
      await api.deleteSkillFile(skill.id, fileId)
      replace({ ...skill, files: skill.files.filter((file) => file.id !== fileId) })
    } catch (cause) {
      fail(cause)
    }
  }

  return (
    <div className="prompt-library skill-library">
      <div className="sidebar-section-label projects-heading">
        <span>{t('skills.title').toUpperCase()}</span>
        {canWrite && !draft && (
          <span className="skill-header-actions">
            <button className="projects-add-button" type="button" aria-label={t('skills.import')} title={t('skills.import')} aria-expanded={importing} onClick={() => setImporting(!importing)}>
              <FileUp size={15} />
            </button>
            <button className="projects-add-button" type="button" aria-label={t('skills.new')} title={t('skills.new')} onClick={() => setDraft({ ...empty })}>
              <Plus size={15} />
            </button>
          </span>
        )}
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
      {importNote && <p className="settings-hint" role="status">{importNote}</p>}
      {importing && (
        <section className="settings-card skill-import" aria-label={t('skills.import')}>
          <p className="settings-hint">{t('skills.importHint')}</p>
          <label className="settings-row settings-switch">
            <span>{t('skills.confidential')}</span>
            <input type="checkbox" role="switch" checked={importConfidential} onChange={(event) => setImportConfidential(event.target.checked)} />
          </label>
          <input ref={zipInput} type="file" hidden accept=".zip,application/zip" aria-label={t('skills.importFile')} onChange={(event) => void importZip(event.target.files)} />
          <button type="button" className="settings-save" onClick={() => zipInput.current?.click()}>
            <FileUp size={13} />
            {t('skills.importFile')}
          </button>
        </section>
      )}

      {draft && (
        <form className="prompt-form" aria-label={draft.id ? t('skills.edit') : t('skills.new')} onSubmit={(event) => void save(event)}>
          <input autoFocus placeholder={t('skills.name')} aria-label={t('skills.name')} value={draft.name} maxLength={60} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <textarea placeholder={t('skills.description')} aria-label={t('skills.description')} rows={2} value={draft.description} maxLength={300} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          <p className="settings-hint">{t('skills.descriptionHint')}</p>
          <textarea placeholder={t('skills.instructions')} aria-label={t('skills.instructions')} rows={8} value={draft.instructions} maxLength={20000} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
          <label className="settings-row settings-switch">
            <span>{t('skills.confidential')}</span>
            <input type="checkbox" role="switch" checked={draft.confidential} onChange={(event) => setDraft({ ...draft, confidential: event.target.checked })} />
          </label>
          <p className="settings-hint">{t('skills.confidentialHint')}</p>
          <div className="prompt-form-actions">
            <button type="button" className="chat-actions-item" onClick={() => setDraft(null)}>
              <X size={14} />
              {t('common.cancel')}
            </button>
            <button type="submit" className="chat-actions-primary" disabled={!draft.name.trim() || !draft.description.trim() || !draft.instructions.trim()}>
              <Check size={14} />
              {t('common.save')}
            </button>
          </div>
        </form>
      )}

      {skills.length === 0 && !draft ? (
        <div className="projects-empty">
          <GraduationCap size={22} />
          <strong>{t('skills.empty')}</strong>
        </div>
      ) : (
        <ul className="prompt-list">
          {skills.map((skill) => (
            <li key={skill.id}>
              <button type="button" className="prompt-item-main" aria-expanded={open === skill.id} onClick={() => setOpen(open === skill.id ? null : skill.id)}>
                <span>
                  <strong>
                    {skill.name}
                    {skill.confidential && <Lock size={11} aria-label={t('skills.confidential')} />}
                    {skill.shared && <Users size={11} aria-label={t('prompts.shared')} />}
                    <small className="skill-version">v{skill.version}</small>
                  </strong>
                  <small>{skill.description}</small>
                </span>
              </button>
              {skill.canEdit && canWrite && (
                <div className="prompt-item-actions">
                  <button type="button" aria-label={t('skills.editNamed', { name: skill.name })} title={t('common.edit')} onClick={() => setDraft({ id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions, confidential: skill.confidential })}>
                    <Pencil size={12} />
                  </button>
                  {skill.mine && (
                    <button type="button" aria-label={t('share.openNamed', { name: skill.name })} title={t('share.access')} aria-expanded={sharing === skill.id} onClick={() => setSharing(sharing === skill.id ? null : skill.id)}>
                      <Share2 size={12} />
                    </button>
                  )}
                  {skill.mine && (
                    <button
                      type="button"
                      className={armed === skill.id ? 'armed' : ''}
                      aria-label={t('skills.delete', { name: skill.name })}
                      title={armed === skill.id ? t('prompts.deleteConfirm') : t('common.delete')}
                      onBlur={() => setArmed(null)}
                      onClick={() => void remove(skill)}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )}
              {open === skill.id && (
                <section className="skill-detail" aria-label={t('skills.files', { name: skill.name })}>
                  <ul className="file-list">
                    {skill.files.map((file) => (
                      <li key={file.id}>
                        {file.mediaType === 'text/x-python' ? <FileCode size={13} /> : <FileText size={13} />}
                        <span className="file-name" title={file.name}>
                          {file.name}
                          {/* Script : exécuté dans le bac à sable, si l'agent peut exécuter du code. */}
                          <small>{file.mediaType === 'text/x-python' ? `${t('skills.script')} · ${formatSize(file.size)}` : formatSize(file.size)}</small>
                        </span>
                        {skill.canEdit && canWrite && (
                          <button type="button" className="icon-button" aria-label={t('skills.removeFile', { name: file.name })} title={t('common.delete')} onClick={() => void removeFile(skill, file.id)}>
                            <X size={12} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {skill.files.length === 0 && <p className="settings-hint">{t('skills.noFiles')}</p>}
                  {skill.canEdit && canWrite && skill.files.length < 10 && (
                    <>
                      <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md,.csv,.json,.py" aria-label={t('skills.addFile')} onChange={(event) => void upload(skill, event.target.files)} />
                      <button type="button" className="settings-secondary" onClick={() => fileInput.current?.click()}>
                        <Paperclip size={13} />
                        {t('skills.addFile')}
                      </button>
                    </>
                  )}
                </section>
              )}
              {sharing === skill.id && <SharePanel resource={{ type: 'skill', id: skill.id, name: skill.name }} onError={setError} />}
            </li>
          ))}
        </ul>
      )}
      <p className="settings-hint prompt-library-hint">{t('skills.hint')}</p>
    </div>
  )
}
