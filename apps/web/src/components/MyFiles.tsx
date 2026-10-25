import { useEffect, useState } from 'react'
import { FileText, Image, Paperclip, Trash2 } from 'lucide-react'
import { api, type AttachmentMeta, type LibraryFile } from '../lib/api'
import { formatSize } from '../lib/format'
import { formatDate, useI18n } from '../lib/i18n'

type Props = {
  conversationId: string
  canWrite: boolean
  /** Copie prête à partir avec le prochain message ; sensitive : la conversation passe en local. */
  onAttached: (attachment: AttachmentMeta, sensitive: boolean) => void
  onError: (message: string) => void
}

/**
 * « Mes fichiers » : ceux déjà envoyés, à rejoindre à cette conversation (copie)
 * ou à supprimer (deux clics : la suppression est définitive).
 */
export default function MyFiles({ conversationId, canWrite, onAttached, onError }: Props) {
  const { t, locale } = useI18n()
  const [files, setFiles] = useState<LibraryFile[] | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listFiles()
      .then((items) => !cancelled && setFiles(items))
      .catch(() => !cancelled && setFiles([]))
    return () => {
      cancelled = true
    }
  }, [])

  async function attach(file: LibraryFile) {
    setBusy(file.id)
    try {
      const copied = await api.copyAttachment(conversationId, file.id)
      onAttached(copied.attachment, copied.sensitive === true)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t('error.send'))
    } finally {
      setBusy(null)
    }
  }

  async function remove(file: LibraryFile) {
    if (armed !== file.id) {
      setArmed(file.id)
      return
    }
    setBusy(file.id)
    try {
      await api.deleteFile(file.id)
      setFiles((current) => current?.filter((item) => item.id !== file.id) ?? null)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t('error.send'))
    } finally {
      setBusy(null)
      setArmed(null)
    }
  }

  return (
    <section className="settings-card" aria-label={t('files.title')}>
      <h3>{t('files.title')}</h3>
      {files?.length === 0 && <p className="settings-hint">{t('files.empty')}</p>}
      <ul className="file-list">
        {(files ?? []).map((file) => (
          <li key={file.id}>
            {file.kind === 'image' ? <Image size={14} /> : <FileText size={14} />}
            <span className="file-name" title={file.name}>
              {file.name}
              <small>
                {formatSize(file.size)} · {formatDate(file.createdAt, locale)}
              </small>
            </span>
            {canWrite && (
              <>
                <button type="button" className="icon-button" aria-label={t('files.attach', { name: file.name })} title={t('files.attachShort')} disabled={busy !== null} onClick={() => void attach(file)}>
                  <Paperclip size={13} />
                </button>
                <button
                  type="button"
                  className={`icon-button file-delete${armed === file.id ? ' armed' : ''}`}
                  aria-label={armed === file.id ? t('files.confirmDelete', { name: file.name }) : t('files.delete', { name: file.name })}
                  title={armed === file.id ? t('files.confirmShort') : t('common.delete')}
                  disabled={busy !== null}
                  onClick={() => void remove(file)}
                  onBlur={() => setArmed((current) => (current === file.id ? null : current))}
                >
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
