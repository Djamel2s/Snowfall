import { useEffect, useState } from 'react'
import { AlertTriangle, Download, FileText, LoaderCircle, X } from 'lucide-react'
import { api, type GeneratedFile } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Props = { conversationId: string; file: GeneratedFile; onClose: () => void }

/**
 * Aperçu d'un document produit (Word, PowerPoint, Excel, PDF), à côté de la
 * conversation : ses premières pages en IMAGES, rendues par la plateforme.
 * Le document lui-même n'est jamais ouvert dans le navigateur (une image
 * n'exécute rien) ; il reste téléchargeable.
 */
export default function FilePreviewPanel({ conversationId, file, onClose }: Props) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<{ pages: string[]; total: number } | { error: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .generatedFilePreview(conversationId, file.id)
      .then((value) => !cancelled && setPreview(value))
      .catch((cause: unknown) => !cancelled && setPreview({ error: cause instanceof Error ? cause.message : String(cause) }))
    return () => {
      cancelled = true
    }
  }, [conversationId, file.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function download() {
    const url = URL.createObjectURL(await api.generatedFileBlob(conversationId, file.id))
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <aside className="artifact-panel document-panel file-preview" aria-label={t('preview.title', { name: file.name })}>
      <header className="artifact-header">
        <FileText size={15} />
        <strong title={file.name}>{file.name}</strong>
        <button type="button" className="artifact-close" aria-label={t('files.download', { name: file.name })} title={t('files.download', { name: file.name })} onClick={() => void download()}>
          <Download size={14} />
        </button>
        <button type="button" className="artifact-close" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className="document-body">
        {file.review?.length ? (
          <p className="message-file-review" role="note" title={t('files.reviewHint')}>
            <AlertTriangle size={12} aria-hidden="true" />
            {t('files.review', { numbers: file.review.join(' · ') })}
          </p>
        ) : null}
        {preview === null ? (
          <p className="document-note">
            <LoaderCircle size={13} className="spin" /> {t('preview.loading')}
          </p>
        ) : 'error' in preview ? (
          <p className="document-note" role="alert">
            {preview.error}
          </p>
        ) : (
          <>
            {preview.pages.map((page, index) => (
              <img key={index} className="file-preview-page" src={`data:image/png;base64,${page}`} alt={t('preview.page', { n: index + 1, total: preview.total })} />
            ))}
            {preview.total > preview.pages.length && <p className="document-note">{t('preview.more', { shown: preview.pages.length, total: preview.total })}</p>}
          </>
        )}
      </div>
    </aside>
  )
}
