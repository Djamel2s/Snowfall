import { useEffect, useId, useRef, useState } from 'react'
import { BookOpen, Check, ChevronDown, Download, ExternalLink, Flag, Globe, Search } from 'lucide-react'
import { api, type MessageSource } from '../lib/api'
import { sourceHost, sourceLabel, stepKind, uniqueHosts } from '../lib/activity'
import { stepSentence } from '../lib/activity-text'
import { useCitations, type CitationIssue } from '../lib/citations'
import { useDocumentViewer } from '../lib/document-view'
import { useI18n } from '../lib/i18n'
import { safeHref } from '../lib/markdown'
import SiteIcon from './SiteIcon'

/** Ouvre un document de la base (téléchargement), ou signale qu'il a été retiré. */
function useDocumentOpener() {
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
      setMissing(source.sourceId)
    }
  }
  return { open, missing }
}

/**
 * Une source en détail : site ou document, titre, extrait lu (texte brut),
 * étape qui l'a trouvée, et l'action pour l'ouvrir. Contenu venu du web ou du
 * modèle : jamais rendu en Markdown ni en HTML.
 */
export function SourceCard({ source, compact = false }: { source: MessageSource; compact?: boolean }) {
  const { t } = useI18n()
  const scope = useCitations()
  const viewer = useDocumentViewer()
  const { open, missing } = useDocumentOpener()
  const [reporting, setReporting] = useState<'ask' | 'sent' | null>(null)
  const href = source.url ? safeHref(source.url) : null
  const host = sourceHost(source)
  const step = scope?.foundBy.get(source.n)
  const where = [host ?? null, source.section ?? null, source.page ? t('cite.page', { page: source.page }) : null].filter(Boolean).join(' · ')
  return (
    <span className={`source-card ${compact ? 'compact' : ''}`}>
      <span className="source-card-head">
        <span className="source-card-number">{source.n}</span>
        <SiteIcon source={source} size={16} />
        <span className="source-card-title">
          <strong>{source.name}</strong>
          {where && <small>{where}</small>}
        </span>
      </span>
      {source.excerpt && !compact && <span className="source-card-excerpt">« {source.excerpt} »</span>}
      <span className="source-card-foot">
        {step && scope && (
          <span className="source-card-origin" title={t('cite.foundBy')}>
            {stepKind(step.name) === 'search' ? <Globe size={11} /> : <Search size={11} />}
            {stepSentence(step, t, scope.consulted)}
          </span>
        )}
        {href ? (
          <a className="source-card-action" href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
            <ExternalLink size={11} />
            {t('cite.open', { host: host ?? '' })}
          </a>
        ) : source.base !== 'web' ? (
          <span className="source-card-actions">
            {viewer && (
              <button type="button" className="source-card-action" onClick={() => viewer(source)}>
                <BookOpen size={11} />
                {t('cite.read')}
              </button>
            )}
            <button
              type="button"
              className={`source-card-action ${viewer ? 'icon' : ''}`}
              disabled={missing === source.sourceId}
              aria-label={t('cite.download')}
              title={missing === source.sourceId ? t('cite.missing') : t('cite.download')}
              onClick={() => void open(source)}
            >
              <Download size={11} />
              {!viewer && (missing === source.sourceId ? t('cite.missing') : t('cite.download'))}
            </button>
          </span>
        ) : null}
      </span>
      {scope?.report && !compact && (
        <span className="source-card-report">
          {reporting === 'sent' ? (
            <span className="source-card-reported" role="status">
              <Check size={11} />
              {t('cite.reported')}
            </span>
          ) : reporting === 'ask' ? (
            <>
              {(['mismatch', 'unreliable'] as CitationIssue[]).map((issue) => (
                <button
                  key={issue}
                  type="button"
                  className="source-card-issue"
                  onClick={() => {
                    void scope.report!(source, issue).then(() => setReporting('sent'))
                  }}
                >
                  {t(`cite.issue.${issue}`)}
                </button>
              ))}
            </>
          ) : (
            <button type="button" className="source-card-flag" onClick={() => setReporting('ask')}>
              <Flag size={10} />
              {t('cite.report')}
            </button>
          )}
        </span>
      )}
    </span>
  )
}

/**
 * Citation dans le texte : une pastille (icône et site, « +1 » s'il y en a
 * plusieurs) qui montre au survol, au focus ou au toucher la carte de chaque
 * source. Numéro inconnu (réponse en cours, source absente) : numéro discret.
 */
export function CitationChip({ numbers }: { numbers: number[] }) {
  const { t } = useI18n()
  const scope = useCitations()
  const [open, setOpen] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  // Un toucher donne le focus (ouverture) puis un clic : ce clic-là ne referme pas.
  const openedAt = useRef(0)
  const id = useId()
  const known = numbers.map((n) => scope?.sources.get(n)).filter((source): source is MessageSource => Boolean(source))

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Sans sources (ancienne réponse, autre contexte) : le texte tel qu'écrit.
  if (!scope) return `[${numbers.join(', ')}]`
  if (!known.length) return <sup className="cite-pending">{numbers.join(', ')}</sup>
  const [first] = known

  const show = () => {
    window.clearTimeout(timer.current)
    // La carte s'ouvre du côté où elle tient (près du bord droit : vers la gauche).
    const rect = anchor.current?.getBoundingClientRect()
    setAlignRight(rect ? window.innerWidth - rect.left < 340 : false)
    if (!open) openedAt.current = Date.now()
    setOpen(true)
  }
  const hide = (delay = 160) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(false), delay)
  }

  return (
    <span
      ref={anchor}
      className={`cite ${open ? 'open' : ''}`}
      onMouseEnter={show}
      onMouseLeave={() => hide()}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide(0)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        type="button"
        className="cite-chip"
        aria-expanded={open}
        aria-controls={id}
        aria-label={known.length === 1 ? t('cite.label', { n: first!.n, name: first!.name }) : t('cite.labelMany', { numbers: known.map((source) => source.n).join(', ') })}
        onClick={() => (open && Date.now() - openedAt.current > 400 ? setOpen(false) : show())}
      >
        <SiteIcon source={first!} size={12} />
        <span className="cite-chip-label">{sourceLabel(first!, 18)}</span>
        {known.length > 1 && <span className="cite-chip-more">+{known.length - 1}</span>}
      </button>
      {open && (
        <span id={id} className={`cite-card ${alignRight ? 'right' : ''}`} role="group" aria-label={t('sources.title')}>
          {known.map((source) => (
            <SourceCard key={source.n} source={source} />
          ))}
        </span>
      )}
    </span>
  )
}

/**
 * Sous la réponse : les sources citées (icônes empilées), dépliées en cartes
 * avec leur extrait ; puis celles que l'agent a lues sans les citer. Ce que
 * l'agent a laissé de côté est aussi une information.
 */
export function SourcesBar({ sources, consulted = [] }: { sources: MessageSource[]; consulted?: MessageSource[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [alsoOpen, setAlsoOpen] = useState(false)
  const cited = new Set(sources.map((source) => source.n))
  const also = consulted.filter((source) => !cited.has(source.n))
  const hosts = uniqueHosts(sources)
  const icons = hosts.length ? hosts.map((host) => ({ url: `https://${host}/`, name: host })) : sources.slice(0, 3)
  return (
    <div className={`sources-bar ${open ? 'open' : ''}`}>
      <button type="button" className="sources-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sources-stack" aria-hidden="true">
          {icons.slice(0, 4).map((source, index) => (
            <SiteIcon key={`${source.name}-${index}`} source={source} size={16} />
          ))}
        </span>
        {sources.length === 1 ? t('sources.one') : t('sources.toggle', { count: sources.length })}
        <ChevronDown size={12} className="sources-chevron" />
      </button>
      {open && (
        <div className="sources-list" aria-label={t('sources.title')}>
          {sources.map((source) => (
            <SourceCard key={source.n} source={source} />
          ))}
          {also.length > 0 && (
            <div className="sources-also">
              <button type="button" className="sources-also-toggle" aria-expanded={alsoOpen} title={t('sources.alsoHint')} onClick={() => setAlsoOpen(!alsoOpen)}>
                <ChevronDown size={11} className="sources-chevron" />
                {t('sources.also', { count: also.length })}
              </button>
              {alsoOpen && also.map((source) => <SourceCard key={source.n} source={source} compact />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
