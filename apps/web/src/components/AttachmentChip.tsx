import { useEffect, useState } from 'react'
import { FileText, ImageIcon, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { api, type AttachmentMeta } from '../lib/api'
import { formatSize } from '../lib/format'
import { useI18n } from '../lib/i18n'

/** Télécharge le fichier déchiffré par l'API (jamais d'URL publique). */
async function download(attachment: Pick<AttachmentMeta, 'id' | 'name'>) {
  const url = URL.createObjectURL(await api.attachmentBlob(attachment.id))
  const link = document.createElement('a')
  link.href = url
  link.download = attachment.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

type Props = {
  attachment?: AttachmentMeta
  name: string
  size: number
  kind: 'document' | 'image'
  status?: 'uploading' | 'ready' | 'error'
  /** Aperçu local (fichier pas encore envoyé). */
  preview?: string
  onRemove?: () => void
}

export default function AttachmentChip({ attachment, name, size, kind, status = 'ready', preview, onRemove }: Props) {
  const { t } = useI18n()
  const [thumbnail, setThumbnail] = useState<string | undefined>(preview)

  useEffect(() => {
    if (preview || kind !== 'image' || !attachment) return
    let url: string | undefined
    let cancelled = false
    api
      .attachmentBlob(attachment.id)
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setThumbnail(url)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [attachment, kind, preview])

  const Icon = status === 'uploading' ? LoaderCircle : status === 'error' ? TriangleAlert : kind === 'image' ? ImageIcon : FileText

  return (
    <div className={`attachment-chip attachment-${status}`}>
      <button
        type="button"
        className="attachment-open"
        disabled={!attachment}
        title={attachment ? t('chat.download', { name }) : name}
        aria-label={attachment ? t('chat.download', { name }) : name}
        onClick={() => attachment && void download(attachment)}
      >
        {thumbnail ? <img src={thumbnail} alt="" /> : <Icon size={15} className={status === 'uploading' ? 'spin' : ''} />}
        <span className="attachment-text">
          <span className="attachment-name">{name}</span>
          <small>{status === 'uploading' ? t('chat.uploading') : formatSize(size)}</small>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="attachment-remove"
          aria-label={t('chat.removeAttachment', { name })}
          title={t('chat.removeAttachment', { name })}
          onClick={onRemove}
        >
          <X size={12} />
        </button>
      )}
    </div>
  )
}
