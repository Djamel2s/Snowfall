import { useRef, type ReactNode } from 'react'
import { Camera, X } from 'lucide-react'
import { useI18n } from '../../lib/i18n'
import { toIconDataUrl } from '../../lib/image'

// Icône d'une ressource (base de connaissances, connecteur) : la photo choisie
// par son auteur, sinon l'icône par défaut. La photo est recadrée et réencodée
// dans le navigateur (EXIF, GPS retirés) avant tout envoi.

/** Photo de la ressource, ou son icône par défaut ; badge : petit signe en coin (cadenas d'une base confidentielle). */
export function EntityIcon({ image, fallback, size = 16, badge }: { image?: string | null; fallback: ReactNode; size?: number; badge?: ReactNode }) {
  if (!image) return <>{fallback}</>
  return (
    <span className="entity-icon" style={{ width: size, height: size }}>
      <img src={image} alt="" width={size} height={size} />
      {badge && <span className="entity-icon-badge">{badge}</span>}
    </span>
  )
}

/** Icône modifiable : un clic choisit une photo, × la retire. */
export function IconPicker({
  image,
  fallback,
  size = 16,
  disabled,
  onChange,
  onError,
}: {
  image?: string | null
  fallback: ReactNode
  size?: number
  disabled?: boolean
  onChange: (icon: string | null) => void
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <span className="icon-picker">
      <button type="button" className="icon-picker-button" aria-label={t('icon.choose')} title={t('icon.choose')} disabled={disabled} onClick={() => fileRef.current?.click()}>
        <EntityIcon image={image} fallback={fallback} size={size} />
        <span className="icon-picker-camera" aria-hidden="true">
          <Camera size={9} />
        </span>
      </button>
      {image && (
        <button type="button" className="icon-picker-remove" aria-label={t('icon.remove')} title={t('icon.remove')} disabled={disabled} onClick={() => onChange(null)}>
          <X size={9} />
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          toIconDataUrl(file)
            .then(onChange)
            .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : t('studio.invalidImage')))
        }}
      />
    </span>
  )
}
