import { useEffect, useRef, useState } from 'react'
import { Download, FileText, LoaderCircle, X } from 'lucide-react'
import { api, type DocumentPassages, type MessageSource } from '../lib/api'
import { locatePassage } from '../lib/document-view'
import { useI18n } from '../lib/i18n'

type Props = { source: MessageSource; onClose: () => void }

/**
 * Document cité, ouvert à côté de la conversation : le texte que l'agent a lu,
 * passage par passage, le passage cité surligné et amené à l'écran. Texte brut
 * (jamais de HTML) ; le fichier d'origine reste téléchargeable.
 */
export default function DocumentPanel({ source, onClose }: Props) {
  const { t } = useI18n()
  const [loaded, setLoaded] = useState<{ id: string; document: DocumentPassages | null } | null>(null)
  const cited = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    api
      .knowledgePassages(source.sourceId)
      .then((document) => !cancelled && setLoaded({ id: source.sourceId, document }))
      .catch(() => !cancelled && setLoaded({ id: source.sourceId, document: null }))
    return () => {
      cancelled = true
    }
  }, [source.sourceId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const document = loaded?.id === source.sourceId ? loaded.document : undefined
  const found = document ? locatePassage(document.passages, source.excerpt) : null

  useEffect(() => {
    cited.current?.scrollIntoView({ block: 'center' })
  }, [document])

  async function download() {
    try {
      const url = URL.createObjectURL(await api.knowledgeSourceBlob(source.sourceId))
      const link = window.document.createElement('a')
      link.href = url
      link.download = source.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      // Document retiré de la base : le panneau le dit déjà.
    }
  }

  return (
    <aside className="artifact-panel document-panel" aria-label={source.name}>
      <header className="artifact-header">
        <FileText size={15} />
        <strong title={source.name}>{document?.name ?? source.name}</strong>
        <button type="button" className="artifact-close" aria-label={t('cite.download')} title={t('cite.download')} onClick={() => void download()}>
          <Download size={14} />
        </button>
        <button type="button" className="artifact-close" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <div className="document-body">
        {document === undefined ? (
          <p className="document-note">
            <LoaderCircle size={13} className="spin" /> {t('common.loading')}
          </p>
        ) : document === null ? (
          <p className="document-note">{t('cite.missing')}</p>
        ) : (
          <>
            {!found && source.excerpt && <p className="document-note">{t('document.notFound')}</p>}
            {document.passages.map((passage, index) => {
              const here = found?.index === index
              const heading = passage.heading && passage.heading !== document.passages[index - 1]?.heading ? passage.heading : null
              return (
                <section key={index} ref={here ? cited : undefined} className={`document-passage ${here ? 'cited' : ''}`} aria-current={here ? 'true' : undefined}>
                  {heading && <h4>{heading}</h4>}
                  {passage.page ? <span className="document-page">{t('cite.page', { page: passage.page })}</span> : null}
                  <p>
                    {here && found.start !== null ? (
                      <>
                        {passage.text.slice(0, found.start)}
                        <mark>{passage.text.slice(found.start, found.start + found.length)}</mark>
                        {passage.text.slice(found.start + found.length)}
                      </>
                    ) : (
                      passage.text
                    )}
                  </p>
                  {here && <span className="document-badge">{t('document.cited', { n: source.n })}</span>}
                </section>
              )
            })}
          </>
        )}
      </div>
    </aside>
  )
}
