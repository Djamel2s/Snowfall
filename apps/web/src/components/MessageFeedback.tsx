import { useState, type FormEvent } from 'react'
import { Send, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { MessageFeedback as Feedback } from '../lib/api'
import { useI18n } from '../lib/i18n'

type Props = {
  feedback: Feedback | undefined
  disabled: boolean
  onChange: (feedback: Feedback | null) => Promise<void>
}

/**
 * 👍 / 👎 sous une réponse. Recliquer retire la note. Après 👎, un commentaire
 * facultatif (chiffré, jamais envoyé aux traces) aide à comprendre ce qui n'allait pas.
 */
export default function MessageFeedback({ feedback, disabled, onChange }: Props) {
  const { t } = useI18n()
  const [asking, setAsking] = useState(false)
  const [comment, setComment] = useState('')

  async function rate(rating: Feedback['rating']) {
    const next = feedback?.rating === rating ? null : { rating }
    await onChange(next)
    setAsking(next?.rating === 'down')
    setComment('')
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    if (!comment.trim()) return
    await onChange({ rating: 'down', comment: comment.trim() })
    setAsking(false)
  }

  return (
    <>
      <button
        type="button"
        className={`copy-message feedback-button ${feedback?.rating === 'up' ? 'on' : ''}`}
        aria-label={t('feedback.up')}
        aria-pressed={feedback?.rating === 'up'}
        title={t('feedback.up')}
        disabled={disabled}
        onClick={() => void rate('up')}
      >
        <ThumbsUp size={14} />
      </button>
      <button
        type="button"
        className={`copy-message feedback-button ${feedback?.rating === 'down' ? 'on' : ''}`}
        aria-label={t('feedback.down')}
        aria-pressed={feedback?.rating === 'down'}
        title={t('feedback.down')}
        disabled={disabled}
        onClick={() => void rate('down')}
      >
        <ThumbsDown size={14} />
      </button>
      {asking && (
        <form className="feedback-comment" onSubmit={(event) => void send(event)}>
          <input
            autoFocus
            maxLength={1000}
            value={comment}
            placeholder={t('feedback.why')}
            aria-label={t('feedback.why')}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setAsking(false)}
          />
          <button type="submit" aria-label={t('feedback.send')} title={t('feedback.send')} disabled={!comment.trim()}>
            <Send size={13} />
          </button>
        </form>
      )}
    </>
  )
}
