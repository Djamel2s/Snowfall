import { useRef, useState } from 'react'
import { Check, ImageUp, RotateCcw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { applyAccent, prepareLogo, refreshBranding, useBranding } from '../lib/branding'
import { useI18n } from '../lib/i18n'

/** Bleu de Snowfall (couleur par défaut de l'interface). */
const DEFAULT_COLOR = '#3d9bf0'
/** Couleurs proposées pour l'interface. */
const PRESETS = ['#e5484d', '#f76b15', '#f5b800', '#30a46c', '#12a594', '#8e4ec6', '#d6409f', '#64748b'] as const

/**
 * Administration › Identité : le logo de l'organisation remplace celui de
 * Snowfall partout (fond, barre, avatars, onglet) ; la couleur de l'interface
 * remplace le bleu (toutes ses nuances). Sans logo importé, celui de Snowfall
 * prend la même couleur.
 */
export default function BrandingSettings({ onError }: { onError: (message: string) => void }) {
  const { t } = useI18n()
  const brand = useBranding()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    onError('')
    try {
      await action()
      await refreshBranding()
    } catch (cause) {
      onError(cause instanceof Error && cause.message === 'too_large' ? t('branding.tooLarge') : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const custom = brand.logoVersion !== null

  return (
    <section className="settings-card branding-card" aria-label={t('branding.title')}>
      <h3>{t('branding.logo')}</h3>
      <div className="branding-logo">
        <img src={brand.logo} alt={t('branding.current')} />
        <div className="branding-logo-actions">
          <input
            ref={fileRef}
            type="file"
            hidden
            accept="image/png,image/jpeg"
            aria-label={t('branding.upload')}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void run(async () => api.uploadLogo(await prepareLogo(file)))
            }}
          />
          <button type="button" className="settings-save" disabled={busy} onClick={() => fileRef.current?.click()}>
            <ImageUp size={14} />
            {t('branding.upload')}
          </button>
          {custom && (
            <button
              type="button"
              className={`settings-secondary${armed ? ' armed' : ''}`}
              disabled={busy}
              onBlur={() => setArmed(false)}
              onClick={() => {
                if (!armed) return setArmed(true)
                setArmed(false)
                void run(() => api.deleteLogo())
              }}
            >
              <Trash2 size={13} />
              {armed ? t('branding.removeConfirm') : t('branding.remove')}
            </button>
          )}
        </div>
      </div>
      <p className="settings-hint">{t('branding.hint')}</p>

      <h3>{t('branding.color')}</h3>
      <div className="branding-colors" role="radiogroup" aria-label={t('branding.color')}>
        <button type="button" role="radio" aria-checked={brand.color === null} aria-label={t('branding.default')} title={t('branding.default')} disabled={busy} onClick={() => void run(() => api.setBrandColor(null))}>
          <span className="branding-swatch" style={{ background: DEFAULT_COLOR }} />
          {brand.color === null && <Check size={11} className="branding-check" />}
        </button>
        {PRESETS.map((color) => (
          <button key={color} type="button" role="radio" aria-checked={brand.color === color} aria-label={color} title={color} disabled={busy} onClick={() => void run(() => api.setBrandColor(color))}>
            <span className="branding-swatch" style={{ background: color }} />
            {brand.color === color && <Check size={11} className="branding-check" />}
          </button>
        ))}
        <label className="branding-custom" title={t('branding.custom')}>
          {/* Enregistrée au relâchement, pas à chaque mouvement du sélecteur. */}
          <input
            type="color"
            aria-label={t('branding.custom')}
            value={picked ?? brand.color ?? DEFAULT_COLOR}
            disabled={busy}
            onChange={(event) => {
              setPicked(event.target.value)
              // Aperçu immédiat, sans enregistrer.
              applyAccent(event.target.value)
            }}
            onBlur={() => {
              if (picked && picked !== brand.color) void run(() => api.setBrandColor(picked))
              else applyAccent(brand.color)
              setPicked(null)
            }}
          />
        </label>
      </div>
      <p className="settings-hint">{t('branding.colorHint')}</p>
      {brand.color && (
        <button type="button" className="settings-secondary" disabled={busy} onClick={() => void run(() => api.setBrandColor(null))}>
          <RotateCcw size={13} />
          {t('branding.reset')}
        </button>
      )}
    </section>
  )
}
