import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import type { Agent, ProviderCatalog } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { providerMeta } from '../lib/providers'
import {
  choiceOf,
  isCurrent,
  responderOptions,
  type Responder,
  type ResponderChoice,
  type ResponderOption,
} from '../lib/responder'
import { AgentAvatar, ProviderLogo } from './AgentAvatar'
import { useBranding } from '../lib/branding'

/** Contrôle clavier depuis le champ de message (mention « @ »). */
export type PickerControl = { handleKey: (event: KeyboardEvent) => boolean }

type Props = {
  current: Responder
  agents: Agent[]
  providers: ProviderCatalog[]
  open: boolean
  /** Texte tapé après « @ » dans le message ; null quand la liste est ouverte au clic. */
  mention: string | null
  onOpenChange: (open: boolean) => void
  onPick: (choice: ResponderChoice) => void
  controlRef?: Ref<PickerControl>
  /** « chip » : bouton compact de l'en-tête (conversation commencée), au lieu de la grande pastille. */
  variant?: 'peek' | 'chip'
}

const responderKey = (current: Responder) =>
  current.kind === 'agent' ? current.agent.id : current.kind === 'model' ? `${current.provider}:${current.model}` : 'default'

/**
 * Le « bonhomme » (ou le logo du modèle) qui dépasse du composer : un clic
 * ouvre la liste des agents et des modèles, comme une mention « @ ».
 */
export default function ResponderPicker({ current, agents, providers, open, mention, onOpenChange, onPick, controlRef, variant = 'peek' }: Props) {
  const { t } = useI18n()
  const brand = useBranding()
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const options = responderOptions(agents, providers, mention ?? query)
  // Élément actif : celui survolé / choisi au clavier, sinon l'actuel, sinon le premier.
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.key === activeKey),
    activeKey ? -1 : options.findIndex((option) => isCurrent(option, current)),
  )
  const active = options[activeIndex]

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open, onOpenChange])

  useEffect(() => {
    if (open && mention === null) searchRef.current?.focus()
  }, [open, mention])

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active?.key ?? '')}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active?.key])

  function toggle() {
    setQuery('')
    setActiveKey(null)
    onOpenChange(!open)
  }

  function pick(option: ResponderOption) {
    setActiveKey(null)
    onOpenChange(false)
    onPick(choiceOf(option))
  }

  function move(step: number) {
    const next = options[Math.min(Math.max(activeIndex + step, 0), options.length - 1)]
    if (next) setActiveKey(next.key)
  }

  function handleKey(event: KeyboardEvent) {
    if (!open) return false
    switch (event.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'Enter':
      case 'Tab':
        if (!active) return false
        pick(active)
        break
      case 'Escape':
        onOpenChange(false)
        break
      default:
        return false
    }
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  useImperativeHandle(controlRef, () => ({ handleKey }))

  const chip = variant === 'chip'
  return (
    <div className={chip ? 'responder-chip' : `composer-peek ${current.kind === 'agent' ? '' : 'composer-peek-model'}`} ref={rootRef}>
      {chip ? (
        <button
          type="button"
          className="topbar-agent responder-chip-button"
          aria-label={t('picker.change')}
          title={t('picker.change')}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={toggle}
        >
          {current.kind === 'agent' ? (
            <>
              <AgentAvatar avatar={current.agent.avatar} size={24} />
              {current.agent.name}
              <ProviderLogo provider={current.agent.provider} size={12} />
            </>
          ) : current.kind === 'model' ? (
            <>
              <ProviderLogo provider={current.provider} size={14} />
              {current.label}
            </>
          ) : (
            <img src={brand.logo} alt="" width={18} height={18} />
          )}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      ) : (
      <>
      <span className="composer-peek-halo" aria-hidden="true" />
      <button
        type="button"
        key={responderKey(current)}
        className="composer-peek-window composer-peek-button"
        aria-label={t('picker.change')}
        title={t('picker.change')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={toggle}
      >
        {current.kind === 'agent' ? (
          <AgentAvatar avatar={current.agent.avatar} size={120} mood="hello" />
        ) : (
          <span className="composer-peek-logo">
            {current.kind === 'model' ? (
              <ProviderLogo provider={current.provider} size={24} />
            ) : (
              <img src={brand.logo} alt="" width={26} height={26} />
            )}
          </span>
        )}
      </button>
      </>
      )}

      {open && (
        <div className="responder-popover" onKeyDown={(event) => void handleKey(event)}>
          {mention === null && (
            <label className="model-select-search">
              <Search size={13} />
              <input
                ref={searchRef}
                aria-label={t('picker.search')}
                placeholder={t('picker.search')}
                value={query}
                aria-controls={listId}
                aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveKey(null)
                }}
              />
            </label>
          )}
          <ul id={listId} ref={listRef} role="listbox" aria-label={t('picker.change')}>
            {options.map((option, index) => {
              const previous = options[index - 1]
              const header =
                option.kind === 'agent'
                  ? index === 0 && <SectionHeader label={t('picker.agents')} />
                  : (previous?.kind !== 'model' || previous.provider !== option.provider) && (
                      <SectionHeader label={providerMeta[option.provider].label} provider={option.provider} />
                    )
              const selected = isCurrent(option, current)
              return [
                header && <li key={`${option.key}-header`} role="presentation">{header}</li>,
                <li
                  key={option.key}
                  id={`${listId}-${index}`}
                  data-key={option.key}
                  role="option"
                  aria-selected={selected}
                  className={`responder-option ${index === activeIndex ? 'active' : ''}`}
                  title={option.kind === 'model' ? option.model : undefined}
                  onPointerEnter={() => setActiveKey(option.key)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                >
                  {option.kind === 'agent' ? (
                    <>
                      <AgentAvatar avatar={option.agent.avatar} size={22} />
                      <span className="responder-option-name">{option.agent.name}</span>
                      <ProviderLogo provider={option.agent.provider} size={11} />
                    </>
                  ) : (
                    <span className="responder-option-name">{option.label}</span>
                  )}
                  {selected && <Check size={13} />}
                </li>,
              ]
            })}
            {options.length === 0 && <li className="model-select-empty">{t('picker.none')}</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

function SectionHeader({ label, provider }: { label: string; provider?: Agent['provider'] }) {
  return (
    <span className="responder-section">
      {provider && <ProviderLogo provider={provider} size={11} />}
      {label}
    </span>
  )
}
