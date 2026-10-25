import { useEffect, useRef, useState } from 'react'
import { Check, Columns2 } from 'lucide-react'
import type { ModelSelection, ProviderCatalog } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { ProviderLogo } from './AgentAvatar'
import Markdown from './Markdown'

/** « Comparer avec… » : la même question posée à un autre modèle autorisé. */
export function CompareMenu({ providers, current, disabled, onPick }: { providers: ProviderCatalog[]; current: string | null; disabled: boolean; onPick: (selection: ModelSelection) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const choices = providers
    .filter((provider) => provider.available && provider.allowed !== false)
    .flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, model: model.id, label: model.label })))
    .filter((choice) => `model:${choice.provider}:${choice.model}` !== current)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  if (!choices.length) return null
  return (
    <div className="compare-menu" ref={root}>
      <button className="copy-message" type="button" aria-label={t('compare.open')} title={t('compare.open')} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
        <Columns2 size={14} />
      </button>
      {open && (
        <ul className="compare-menu-list" role="menu" aria-label={t('compare.open')}>
          {choices.map((choice) => (
            <li key={`${choice.provider}:${choice.model}`}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onPick({ provider: choice.provider, model: choice.model })
                }}
              >
                <ProviderLogo provider={choice.provider} size={13} />
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Side = { label: string; content: string }

/** Deux réponses côte à côte ; on garde l'une, l'autre reste une version consultable. */
export function ComparePair({ left, right, done, onKeepLeft, onKeepRight }: { left: Side; right: Side; done: boolean; onKeepLeft: () => void; onKeepRight: () => void }) {
  const { t } = useI18n()
  return (
    <div className="compare-pair" role="group" aria-label={t('compare.title')}>
      {[
        { side: left, keep: onKeepLeft, key: 'left' },
        { side: right, keep: onKeepRight, key: 'right' },
      ].map(({ side, keep, key }) => (
        <section key={key} className="compare-column" aria-label={side.label}>
          <div className="compare-label">{side.label}</div>
          {side.content ? <Markdown source={side.content} showCode /> : <div className="typing-indicator" aria-label={t('chat.answering')}><span /><span /><span /></div>}
          {done && (
            <button type="button" className="settings-secondary" onClick={keep}>
              <Check size={13} />
              {t('compare.keep')}
            </button>
          )}
        </section>
      ))}
    </div>
  )
}
