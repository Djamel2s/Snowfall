import { useEffect, useState } from 'react'
import { AlertTriangle, Download, FileSpreadsheet, FileText, FileType, Presentation } from 'lucide-react'
import { api, type GeneratedFile } from '../lib/api'
import { formatNumber, useI18n } from '../lib/i18n'

/** Image affichable : seulement PNG et JPEG (un SVG peut contenir du script). */
const isImage = (file: GeneratedFile) => file.mediaType === 'image/png' || file.mediaType === 'image/jpeg'

/** Format d'un fichier produit : icône et nom court (Word, PowerPoint, Excel, PDF). */
function kindOf(mediaType: string) {
  if (mediaType.includes('presentationml')) return { Icon: Presentation, label: 'PowerPoint', tone: 'pptx' }
  if (mediaType.includes('wordprocessingml')) return { Icon: FileText, label: 'Word', tone: 'docx' }
  if (mediaType.includes('sheet') || mediaType === 'text/csv') return { Icon: FileSpreadsheet, label: mediaType === 'text/csv' ? 'CSV' : 'Excel', tone: 'xlsx' }
  if (mediaType === 'application/pdf') return { Icon: FileType, label: 'PDF', tone: 'pdf' }
  return { Icon: FileText, label: null, tone: '' }
}

function GeneratedImage({ conversationId, file }: { conversationId: string; file: GeneratedFile }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let current: string | null = null
    let cancelled = false
    api
      .generatedFileBlob(conversationId, file.id)
      .then((blob) => {
        if (cancelled) return
        current = URL.createObjectURL(blob)
        setUrl(current)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (current) URL.revokeObjectURL(current)
    }
  }, [conversationId, file.id])
  return url ? <img className="message-file-image" src={url} alt={file.name} /> : <div className="message-file-image placeholder" />
}

/** Formats qui ont un aperçu (pages rendues par la plateforme). */
const PREVIEWABLE = new Set(['pptx', 'docx', 'xlsx', 'pdf'])

/** Fichiers produits par l'interpréteur de code pour une réponse. */
export default function MessageFiles({ conversationId, files, onPreview }: { conversationId: string; files: GeneratedFile[]; onPreview?: (file: GeneratedFile) => void }) {
  const { t } = useI18n()

  async function download(file: GeneratedFile) {
    const url = URL.createObjectURL(await api.generatedFileBlob(conversationId, file.id))
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div className="message-files" aria-label={t('files.generated')}>
      {files.filter(isImage).map((file) => (
        <figure key={file.id} className="message-file-figure">
          <GeneratedImage conversationId={conversationId} file={file} />
          <figcaption>
            <span>{file.name}</span>
            <button type="button" aria-label={t('files.download', { name: file.name })} title={t('files.download', { name: file.name })} onClick={() => void download(file)}>
              <Download size={12} />
            </button>
          </figcaption>
        </figure>
      ))}
      {files
        .filter((file) => !isImage(file))
        .map((file) => {
          const { Icon, label, tone } = kindOf(file.mediaType)
          const previewable = onPreview && PREVIEWABLE.has(tone) && !(tone === 'xlsx' && file.mediaType === 'text/csv')
          const details = (
            <>
              <Icon size={13} />
              <span>{file.name}</span>
              <small>
                {label ? `${label} · ` : ''}
                {formatNumber(Math.max(1, Math.round(file.size / 1024)))} Ko
              </small>
            </>
          )
          // Document avec aperçu : la carte ouvre l'aperçu, la flèche à droite télécharge.
          // Sans aperçu (CSV…) : la carte télécharge, comme avant.
          const card = previewable ? (
            <span key={file.id} className={`message-file split ${tone}`}>
              <button type="button" className="message-file-open" aria-label={t('preview.open', { name: file.name })} title={t('preview.open', { name: file.name })} onClick={() => onPreview(file)}>
                {details}
              </button>
              <button type="button" className="message-file-download" aria-label={t('files.download', { name: file.name })} title={t('files.download', { name: file.name })} onClick={() => void download(file)}>
                <Download size={12} />
              </button>
            </span>
          ) : (
            <button key={file.id} type="button" className={`message-file ${tone}`} title={t('files.download', { name: file.name })} onClick={() => void download(file)}>
              {details}
              <Download size={12} />
            </button>
          )
          // Contrôle de fidélité : la personne voit les nombres à vérifier (le modèle, lui, ignore l'alerte).
          if (!file.review?.length) return card
          return (
            <div key={file.id} className="message-file-checked">
              {card}
              <p className="message-file-review" role="note" title={t('files.reviewHint')}>
                <AlertTriangle size={12} aria-hidden="true" />
                {t('files.review', { numbers: file.review.join(' · ') })}
              </p>
            </div>
          )
        })}
    </div>
  )
}
