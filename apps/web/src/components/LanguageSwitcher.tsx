import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import FR from 'country-flag-icons/react/1x1/FR'
import GB from 'country-flag-icons/react/1x1/GB'

const languages = [
  { code: 'fr', label: 'Français', Flag: FR },
  { code: 'en', label: 'English', Flag: GB },
] as const

export type LanguageCode = (typeof languages)[number]['code']

const STORAGE_KEY = 'snowfall:locale'

function initialLanguage(): LanguageCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (languages.some((language) => language.code === saved)) {
      return saved as LanguageCode
    }
  } catch {
    // Stockage indisponible (navigation privée…) : langue par défaut.
  }
  return 'fr'
}

export default function LanguageSwitcher({
  onChange,
}: {
  onChange?: (code: LanguageCode) => void
}) {
  const [current, setCurrent] = useState<LanguageCode>(initialLanguage)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const active = languages.find((language) => language.code === current) ?? languages[0]

  useEffect(() => {
    document.documentElement.lang = current
  }, [current])

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    itemRefs.current[languages.findIndex((language) => language.code === current)]?.focus()

    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, current])

  function select(code: LanguageCode) {
    setCurrent(code)
    setOpen(false)
    buttonRef.current?.focus()
    try {
      localStorage.setItem(STORAGE_KEY, code)
    } catch {
      // Préférence non conservée : sans gravité.
    }
    onChange?.(code)
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement)

    if (event.key === 'Escape') {
      setOpen(false)
      buttonRef.current?.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      itemRefs.current[(index + step + languages.length) % languages.length]?.focus()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="language-switcher" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="language-flag"
        aria-label={`Langue : ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.label}
        onClick={() => setOpen((value) => !value)}
      >
        <active.Flag aria-hidden="true" />
      </button>

      {open && (
        <div className="language-menu" role="menu" aria-label="Choisir la langue" onKeyDown={onMenuKeyDown}>
          {languages.map(({ code, label, Flag }, index) => (
            <button
              key={code}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              type="button"
              role="menuitemradio"
              aria-checked={code === current}
              aria-label={label}
              title={label}
              className="language-flag"
              onClick={() => select(code)}
            >
              <Flag aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
