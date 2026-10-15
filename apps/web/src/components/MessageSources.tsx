import { useState } from 'react'
import { FileText, Link2 } from 'lucide-react'
import { api, type MessageSource } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { safeHref } from '../lib/markdown'

/** Sources citées par une réponse : [n] renvoie au document ou au lien. */
export default function MessageSources({ sources }: { sources: MessageSource[] }) {
  const { t } = useI18n()
  const [missing, setMissing] = useState<string | null>(null)

  async function open(source: MessageSource) {
    try {
      const url = URL.createObjectURL(await api.knowledgeSourceBlob(source.sourceId))
      const link = document.createElement('a')
      link.href = url
      link.download = source.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      // Source retirée de la base depuis la réponse.
      setMissing(source.sourceId)
    }
  }

  return (
    <div className="message-sources" aria-label={t('knowledge.sources')}>
      {sources.map((source) => {
        const href = source.url ? safeHref(source.url) : null
        const content = (
          <>
            <span className="message-source-number">{source.n}</span>
            {href ? <Link2 size={11} /> : <FileText size={11} />}
            <span className="message-source-name">{source.name}</span>
            {source.page ? <small className="message-source-page">{t('knowledge.page', { page: source.page })}</small> : null}
          </>
        )
        return href ? (
          <a
            key={source.n}
            className="message-source"
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={[t('knowledge.open', { name: source.name }), source.section].filter(Boolean).join(' · ')}
          >
            {content}
          </a>
        ) : (
          <button
            key={source.n}
            type="button"
            className={`message-source ${missing === source.sourceId ? 'missing' : ''}`}
            title={[t('knowledge.download', { name: source.name }), source.section].filter(Boolean).join(' · ')}
            onClick={() => void open(source)}
          >
            {content}
          </button>
        )
      })}
    </div>
  )
}
