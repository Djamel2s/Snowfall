import { useImperativeHandle, useMemo, useState, type KeyboardEvent, type Ref } from 'react'
import { ScrollText, Users } from 'lucide-react'
import type { Prompt } from '../lib/api'
import { useI18n } from '../lib/i18n'
import type { PickerControl } from './ResponderPicker'

type Props = {
  prompts: Prompt[]
  query: string
  controlRef: Ref<PickerControl>
  onPick: (prompt: Prompt) => void
  onClose: () => void
}

/** « / » dans la zone de saisie : choisir un prompt de la bibliothèque (clavier ou souris). */
export default function PromptPicker({ prompts, query, controlRef, onPick, onClose }: Props) {
  const { t } = useI18n()
  const [active, setActive] = useState(0)
  const shown = useMemo(() => {
    const needle = query.toLocaleLowerCase()
    return prompts.filter((prompt) => prompt.name.toLocaleLowerCase().includes(needle)).slice(0, 8)
  }, [prompts, query])
  const current = Math.min(active, Math.max(0, shown.length - 1))

  useImperativeHandle(controlRef, () => ({
    handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return true
      }
      if (!shown.length) return false
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        onPick(shown[current]!)
        return true
      }
      return false
    },
  }))

  return (
    <div className="prompt-picker" role="listbox" aria-label={t('prompts.title')}>
      {shown.length === 0 ? (
        <p className="prompt-picker-empty">{prompts.length ? t('prompts.noMatch') : t('prompts.empty')}</p>
      ) : (
        shown.map((prompt, index) => (
          <button
            key={prompt.id}
            type="button"
            role="option"
            aria-selected={index === current}
            className={index === current ? 'active' : ''}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(prompt)}
          >
            <ScrollText size={14} />
            <span>
              <strong>{prompt.name}</strong>
              <small>{prompt.content.replace(/\s+/g, ' ').slice(0, 90)}</small>
            </span>
            {prompt.shared && <Users size={12} aria-label={t('prompts.shared')} />}
          </button>
        ))
      )}
    </div>
  )
}
