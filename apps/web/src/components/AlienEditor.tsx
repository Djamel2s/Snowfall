import { alienAccessories, alienColors, alienEyes, type AlienAvatar } from '../lib/api'
import { alienPalette } from '../lib/alien'
import { useI18n } from '../lib/i18n'
import Alien from './Alien'

type Props = {
  value: AlienAvatar
  onChange: (patch: Partial<AlienAvatar>) => void
}

export default function AlienEditor({ value, onChange }: Props) {
  const { t } = useI18n()
  return (
    <div className="studio-options">
      <div className="studio-row" role="radiogroup" aria-label={t('studio.color')}>
        {alienColors.map((color) => {
          const tone = alienPalette[color]
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={value.color === color}
              aria-label={color}
              className="swatch"
              style={{ background: `radial-gradient(circle at 35% 30%, ${tone.light} 0, ${tone.base} 45%, ${tone.shade} 100%)` }}
              onClick={() => onChange({ color })}
            />
          )
        })}
      </div>

      <div className="studio-grid" role="radiogroup" aria-label={t('studio.eyes')}>
        {alienEyes.map((eyes) => (
          <button
            key={eyes}
            type="button"
            role="radio"
            aria-checked={value.eyes === eyes}
            aria-label={eyes}
            className="variant"
            onClick={() => onChange({ eyes })}
          >
            <Alien avatar={{ ...value, eyes, accessory: 'none' }} size={34} />
          </button>
        ))}
      </div>

      <div className="studio-grid" role="radiogroup" aria-label={t('studio.accessory')}>
        {alienAccessories.map((accessory) => (
          <button
            key={accessory}
            type="button"
            role="radio"
            aria-checked={value.accessory === accessory}
            aria-label={accessory}
            className="variant"
            onClick={() => onChange({ accessory })}
          >
            <Alien avatar={{ ...value, accessory }} size={34} />
          </button>
        ))}
      </div>
    </div>
  )
}
