import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import {
  ArrowRight,
  Download,
  FileText,
  Link2,
  LoaderCircle,
  Lock,
  LockOpen,
  RefreshCw,
  Search,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { api, type KnowledgeBaseView, type KnowledgeOwnerKind, type KnowledgeSource } from '../lib/api'
import { formatNumber, useI18n } from '../lib/i18n'
import { safeHref } from '../lib/markdown'
import { draftLink, emptyKnowledgeDraft, type KnowledgeDraft } from '../lib/knowledge-draft'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const POLL_MS = 1_500

/** Télécharge l'original déchiffré par l'API (jamais d'URL publique). */
async function download(source: KnowledgeSource) {
  const url = URL.createObjectURL(await api.knowledgeSourceBlob(source.id))
  const link = document.createElement('a')
  link.href = url
  link.download = source.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

type FailureKey =
  | 'knowledge.failed.link'
  | 'knowledge.failed.blocked'
  | 'knowledge.failed.unreadable'
  | 'knowledge.failed.empty'
  | 'knowledge.failed.embedding'
  | 'knowledge.failed.quota'
  | 'knowledge.failed.format'
  | 'knowledge.failed.full'
  | 'knowledge.failed.generic'
  | 'knowledge.failed.malware'

/** Code d'échec renvoyé par l'API → libellé court. */
function failureKey(code: string | null): FailureKey {
  if (!code) return 'knowledge.failed.generic'
  if (code === 'malware') return 'knowledge.failed.malware'
  if (code === 'link_proxy_denied') return 'knowledge.failed.blocked'
  if (code === 'link_blocked_address' || code === 'link_domain_not_allowed') return 'knowledge.failed.blocked'
  if (code.startsWith('link_') || code === 'links_disabled') return 'knowledge.failed.link'
  if (code === 'unreadable' || code === 'extraction_timeout') return 'knowledge.failed.unreadable'
  if (code === 'empty') return 'knowledge.failed.empty'
  if (code === 'embedding_failed' || code === 'provider_not_allowed') return 'knowledge.failed.embedding'
  if (code === 'quota_exceeded') return 'knowledge.failed.quota'
  if (['audio_video', 'image', 'unsupported', 'too_large'].includes(code)) return 'knowledge.failed.format'
  if (code === 'too_many_chunks' || code === 'too_many_sources') return 'knowledge.failed.full'
  return 'knowledge.failed.generic'
}

type Props = {
  kind: KnowledgeOwnerKind
  /** Absent : propriétaire pas encore créé, les documents sont mis en attente (brouillon). */
  ownerId?: string
  /** Prévient le parent quand le nombre de sources prêtes change. */
  onChange?: (ready: number) => void
  draft?: KnowledgeDraft
  onDraftChange?: (draft: KnowledgeDraft) => void
  /** Brouillon : le mode confidentiel n'est possible qu'avec un modèle local. */
  confidentialAllowed?: boolean
}

/**
 * Base de connaissances d'un agent ou d'un projet : fichiers et liens,
 * indexés côté serveur (chiffrés), avec leur état d'avancement.
 */
export default function KnowledgePanel(props: Props) {
  const { kind, ownerId, onChange } = props
  const { t } = useI18n()
  const [view, setView] = useState<KnowledgeBaseView | null>(null)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  // Incrémentée pour recharger la base (après une action, pendant un import).
  const [version, setVersion] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  const refresh = useCallback(() => setVersion((current) => current + 1), [])

  useEffect(() => {
    if (!ownerId) return
    let cancelled = false
    api
      .getKnowledge(kind, ownerId)
      .then((next) => {
        if (cancelled) return
        setView(next)
        onChangeRef.current?.(next.sources.filter((source) => source.status === 'ready').length)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t('knowledge.failed.generic'))
      })
    return () => {
      cancelled = true
    }
  }, [kind, ownerId, version, t])

  // Suivi des imports en cours, tant qu'il en reste.
  const working = view?.sources.some((source) => source.status === 'pending' || source.status === 'processing') ?? false
  useEffect(() => {
    if (!working) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [working, refresh])

  async function run(action: () => Promise<unknown>) {
    setError('')
    setBusy(true)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('knowledge.failed.generic'))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  // Brouillon : la liste vit chez le parent, envoyée après la création.
  const draft = ownerId ? null : (props.draft ?? emptyKnowledgeDraft)
  const setDraft = (next: KnowledgeDraft) => props.onDraftChange?.(next)
  const nextDraftId = useRef(0)
  const draftId = () => `draft-${++nextDraftId.current}`

  function addFiles(files: File[]) {
    if (files.some((file) => file.size > MAX_FILE_BYTES)) {
      setError(t('error.fileTooLarge'))
      return
    }
    if (draft) {
      setError('')
      setDraft({ ...draft, items: [...draft.items, ...files.map((file) => ({ id: draftId(), kind: 'file' as const, name: file.name, file }))] })
      return
    }
    void run(async () => {
      for (const file of files) await api.addKnowledgeFile(kind, ownerId!, file, file.name)
    })
  }

  function addLink() {
    const url = link.trim()
    if (!url) return
    if (draft) {
      const checked = draftLink(url)
      if (!checked) {
        setError(t('knowledge.error.invalidLink'))
        return
      }
      setError('')
      setDraft({ ...draft, items: [...draft.items, { id: draftId(), kind: 'link', name: new URL(checked).host, url: checked }] })
      setLink('')
      return
    }
    void run(async () => {
      await api.addKnowledgeLink(kind, ownerId!, url)
      setLink('')
    })
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    if (canManage && event.dataTransfer.files.length) addFiles([...event.dataTransfer.files])
  }

  const canManage = draft ? true : (view?.canManage ?? false)
  // Brouillon : on ne sait pas encore si l'admin autorise les liens ; le serveur tranchera à l'envoi.
  const linksEnabled = draft ? true : (view?.linksEnabled ?? false)
  const confidential = draft ? draft.confidential : (view?.confidential ?? false)
  const sources = view?.sources ?? []

  return (
    <section className="knowledge-panel" aria-label={t('knowledge.title')}>
      <div className="knowledge-heading">
        <span className="sidebar-section-label">{t('knowledge.title')}</span>
        {(view || draft) && (
          <button
            type="button"
            className={`knowledge-lock ${confidential ? 'on' : ''}`}
            aria-pressed={confidential}
            disabled={!canManage || busy || (!!draft && !confidential && !props.confidentialAllowed)}
            title={draft && !props.confidentialAllowed ? t('knowledge.error.agentLocal') : t('knowledge.confidentialHint')}
            onClick={() =>
              draft
                ? setDraft({ ...draft, confidential: !draft.confidential })
                : void run(() => api.setKnowledgeConfidential(kind, ownerId!, !confidential))
            }
          >
            {confidential ? <Lock size={12} /> : <LockOpen size={12} />}
            {t('knowledge.confidential')}
          </button>
        )}
      </div>

      {canManage && (
        <div
          className={`knowledge-drop ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <button type="button" className="knowledge-upload" title={t('knowledge.formats')} disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={14} />
            {t('knowledge.addFile')}
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            onChange={(event) => {
              addFiles([...(event.target.files ?? [])])
              event.target.value = ''
            }}
          />
          {linksEnabled && (
            // Pas de <form> : le panneau peut vivre dans le formulaire du studio d'agent.
            <div className="knowledge-link">
              <Link2 size={13} />
              <input
                type="url"
                inputMode="url"
                placeholder={t('knowledge.linkPlaceholder')}
                aria-label={t('knowledge.linkPlaceholder')}
                value={link}
                maxLength={2000}
                onChange={(event) => setLink(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  addLink()
                }}
              />
              <button type="button" aria-label={t('knowledge.addLink')} title={t('knowledge.addLink')} disabled={busy || !link.trim()} onClick={addLink}>
                <ArrowRight size={13} />
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="knowledge-error" role="alert">
          {error}
        </p>
      )}

      {draft ? (
        draft.items.length > 0 ? (
          <ul className="knowledge-sources">
            {draft.items.map((item) => {
              const Icon = item.kind === 'link' ? Link2 : FileText
              return (
                <li key={item.id} className="knowledge-source knowledge-queued">
                  <Icon size={14} />
                  <span className="knowledge-source-text">
                    <span className="knowledge-source-name" title={item.kind === 'link' ? item.url : item.name}>
                      {item.name}
                    </span>
                    <small>{t('knowledge.queued')}</small>
                  </span>
                  <span className="knowledge-source-actions">
                    <button
                      type="button"
                      aria-label={t('knowledge.remove', { name: item.name })}
                      title={t('knowledge.remove', { name: item.name })}
                      onClick={() => setDraft({ ...draft, items: draft.items.filter((other) => other.id !== item.id) })}
                    >
                      <X size={12} />
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="knowledge-empty">{t('knowledge.empty')}</p>
        )
      ) : sources.length > 0 ? (
        <ul className="knowledge-sources">
          {sources.map((source) => {
            const href = source.kind === 'link' && source.url ? safeHref(source.url) : null
            const Icon = source.status === 'error' ? TriangleAlert : source.kind === 'link' ? Link2 : FileText
            const loading = source.status === 'pending' || source.status === 'processing'
            return (
              <li key={source.id} className={`knowledge-source knowledge-${source.status}`}>
                {loading ? <LoaderCircle size={14} className="spin" /> : <Icon size={14} />}
                <span className="knowledge-source-text">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={source.url ?? ''}>
                      {source.name}
                    </a>
                  ) : (
                    <span className="knowledge-source-name" title={source.name}>
                      {source.name}
                    </span>
                  )}
                  <small>
                    {source.status === 'pending'
                      ? t('knowledge.pending')
                      : source.status === 'processing'
                        ? t('knowledge.processing')
                        : source.status === 'error'
                          ? t(failureKey(source.errorCode))
                          : t('knowledge.chunks', { count: formatNumber(source.chunkCount) })}
                  </small>
                </span>
                <span className="knowledge-source-actions">
                  {source.status === 'ready' && source.size > 0 && (
                    <button type="button" aria-label={t('knowledge.download', { name: source.name })} title={t('knowledge.download', { name: source.name })} onClick={() => void download(source)}>
                      <Download size={12} />
                    </button>
                  )}
                  {canManage && source.status === 'error' && failureKey(source.errorCode) !== 'knowledge.failed.format' && (
                    <button type="button" aria-label={t('knowledge.reindex')} title={t('knowledge.reindex')} onClick={() => void run(() => api.reindexKnowledgeSource(source.id))}>
                      <RefreshCw size={12} />
                    </button>
                  )}
                  {canManage && (
                    <button
                      type="button"
                      className={armed === source.id ? 'armed' : ''}
                      aria-label={armed === source.id ? t('common.confirm') : t('knowledge.remove', { name: source.name })}
                      title={armed === source.id ? t('common.confirm') : t('knowledge.remove', { name: source.name })}
                      onBlur={() => setArmed(null)}
                      onClick={() => {
                        if (armed !== source.id) {
                          setArmed(source.id)
                          return
                        }
                        setArmed(null)
                        void run(() => api.deleteKnowledgeSource(source.id))
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        view && canManage && <p className="knowledge-empty">{t('knowledge.empty')}</p>
      )}

      {view && sources.length > 0 && (
        <p className="knowledge-mode">
          {view.embeddingModel ? <Sparkles size={11} /> : <Search size={11} />}
          {view.embeddingModel ? t('knowledge.semantic', { model: view.embeddingModel.split(':').slice(1).join(':') }) : t('knowledge.keywords')}
        </p>
      )}
    </section>
  )
}
