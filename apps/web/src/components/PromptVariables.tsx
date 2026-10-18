import { useState, type FormEvent } from 'react'
import { Check, X } from 'lucide-react'
import type { Prompt } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { fillPrompt, promptVariables } from '../lib/prompts'

/** Prompt à variables : on les renseigne, puis le texte complet arrive dans la zone de saisie. */
export default function PromptVariables({ prompt, onInsert, onCancel }: { prompt: Prompt; onInsert: (text: string) => void; onCancel: () => void }) {
  const { t } = useI18n()
  const variables = promptVariables(prompt.content)
  const [values, setValues] = useState<Record<string, string>>({})

  function submit(event: FormEvent) {
    event.preventDefault()
    onInsert(fillPrompt(prompt.content, values))
  }

  return (
    <form className="prompt-variables" aria-label={t('prompts.fill', { name: prompt.name })} onSubmit={submit}>
      <strong>{prompt.name}</strong>
      {variables.map((name, index) => (
        <label key={name}>
          <span>{name}</span>
          <input
            autoFocus={index === 0}
            value={values[name] ?? ''}
            maxLength={2000}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
            onKeyDown={(event) => event.key === 'Escape' && onCancel()}
          />
        </label>
      ))}
      <div className="prompt-variables-actions">
        <button type="button" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={onCancel}>
          <X size={14} />
        </button>
        <button type="submit" className="chat-actions-primary">
          <Check size={14} />
          {t('prompts.insert')}
        </button>
      </div>
    </form>
  )
}
