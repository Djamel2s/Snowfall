import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { ProviderId } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { ProviderLogo } from './AgentAvatar'

type Props = {
  provider: ProviderId
  models: { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
}

// Recherche affichée seulement quand la liste devient longue (OpenAI, Gemini…).
const SEARCH_FROM = 8

export default function ModelSelect({ provider, models, value, onChange }: Props) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const selected = models.find((model) => model.id === value)
  const filtered = query
    ? models.filter((model) => `${model.label} ${model.id}`.toLowerCase().includes(query.toLowerCase()))
    : models

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  useEffect(() => {
    if (!open) return
    if (models.length >= SEARCH_FROM) searchRef.current?.focus()
    else listRef.current?.focus()
  }, [open, models.length])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function show() {
    setQuery('')
    setActive(Math.max(0, models.findIndex((model) => model.id === value)))
    setOpen(true)
  }

  function pick(id: string) {
    onChange(id)
    setOpen(false)
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        show()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => Math.min(index + 1, filtered.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive((index) => Math.max(index - 1, 0))
        break
      case 'Enter': {
        event.preventDefault()
        const model = filtered[active]
        if (model) pick(model.id)
        break
      }
      case 'Escape':
        // Ferme seulement la liste, pas tout le studio.
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        break
      case 'Tab':
        setOpen(false)
        break
    }
  }

  return (
    <div className="model-select" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="model-select-trigger"
        role="combobox"
        aria-label={t('studio.model')}
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        onClick={() => (open ? setOpen(false) : show())}
      >
        <ProviderLogo provider={provider} size={15} />
        <span className="model-select-value" title={selected?.id}>{selected?.label ?? t('model.choose')}</span>
        <ChevronDown size={15} className="model-select-chevron" />
      </button>

      {open && (
        <div className="model-select-popover">
          {models.length >= SEARCH_FROM && (
            <label className="model-select-search">
              <Search size={13} />
              <input
                ref={searchRef}
                aria-label={t('model.search')}
                placeholder={t('sidebar.search')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActive(0)
                }}
              />
            </label>
          )}
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label={t('model.list')}
            tabIndex={-1}
            aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
          >
            {filtered.map((model, index) => (
              <li
                key={model.id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={model.id === value}
                className={index === active ? 'active' : undefined}
                title={model.id}
                onPointerEnter={() => setActive(index)}
                onClick={() => pick(model.id)}
              >
                <span>{model.label}</span>
                {model.id === value && <Check size={13} />}
              </li>
            ))}
            {filtered.length === 0 && <li className="model-select-empty">{t('model.none')}</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
