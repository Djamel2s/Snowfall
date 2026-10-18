import { useEffect, useState } from 'react'
import { Eye, X } from 'lucide-react'
import { api, type OpenedShare } from '../lib/api'
import { formatDate, useI18n } from '../lib/i18n'
import { AgentAvatar } from './AgentAvatar'
import Markdown from './Markdown'

/**
 * Conversation partagée, en lecture seule : l'instantané figé au moment du
 * partage (texte et noms des sources), sans saisie ni action.
 */
export default function SharedView({ token, onClose }: { token: string; onClose: () => void }) {
  const { t, locale } = useI18n()
  const [share, setShare] = useState<OpenedShare | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .openShare(token)
      .then((opened) => !cancelled && setShare(opened))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <section className="shared-view" aria-label={t('share.viewTitle')}>
      <header className="shared-banner">
        <Eye size={15} />
        <span>
          <strong>{share?.title ?? t('share.viewTitle')}</strong>
          {share && <small>{t('share.readOnly', { date: formatDate(share.expiresAt, locale) })}</small>}
        </span>
        <button type="button" className="icon-button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {failed && <p className="shared-empty">{t('share.unavailable')}</p>}
      {share && (
        <section className="messages shared-messages">
          {share.snapshot.messages.map((message, index) => (
            <article key={index} className={`message message-${message.role}`}>
              <div className={`message-avatar ${message.role === 'assistant' && share.snapshot.agent ? 'message-avatar-agent' : ''}`}>
                {message.role === 'assistant' && share.snapshot.agent ? <AgentAvatar avatar={share.snapshot.agent.avatar} size={30} /> : <span className="message-badge">{message.role === 'user' ? '·' : '✳'}</span>}
              </div>
              <div className="message-body">
                <div className="message-author">{message.role === 'user' ? t('export.user') : (share.snapshot.agent?.name ?? t('export.assistant'))}</div>
                {message.role === 'assistant' ? <Markdown source={message.content} /> : <p>{message.content}</p>}
                {message.sources?.length ? (
                  <ul className="shared-sources" aria-label={t('export.sources')}>
                    {message.sources.map((source) => (
                      <li key={source.n}>
                        [{source.n}] {source.name}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      )}
    </section>
  )
}
