import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ArrowRight, BookOpen, ChevronRight, FileText, Folder, FolderInput, FolderPlus, Link2, LoaderCircle, Lock, LockOpen, Pencil, RefreshCw, Search, Share2, Sparkles, Trash2, TriangleAlert, Upload, X } from 'lucide-react'
import { api, type KnowledgeFolder, type KnowledgeSource, type LibraryBaseDetail } from '../../lib/api'
import { useDocumentViewer } from '../../lib/document-view'
import { formatNumber, useI18n } from '../../lib/i18n'
import { failureKey } from '../../lib/knowledge-status'
import { safeHref } from '../../lib/markdown'
import SharePanel from '../SharePanel'
import { InlineEdit, ListEmpty, ListRow, ListRows, ListSection, PanelBack, RowAction, SectionAction } from '../ui/List'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const POLL_MS = 1_500

/** Chemin lisible d'un dossier (« Contrats › 2026 »). */
function folderPath(folders: KnowledgeFolder[], id: string | null): KnowledgeFolder[] {
  const path: KnowledgeFolder[] = []
  let cursor = id ? folders.find((folder) => folder.id === id) : undefined
  while (cursor && path.length < 10) {
    path.unshift(cursor)
    cursor = cursor.parentId ? folders.find((folder) => folder.id === cursor!.parentId) : undefined
  }
  return path
}

type Props = {
  baseId: string
  /** Nom affiché quand la base n'en a pas (reprise d'un agent ou d'un projet). */
  fallbackName: string
  canWrite: boolean
  onBack: () => void
  onDeleted: () => void
  onChanged: () => void
}

/**
 * Une base de la bibliothèque, comme un explorateur : un fil d'Ariane, les
 * dossiers puis les documents du dossier ouvert. Ajouter (fichiers, liens),
 * ranger, renommer, partager, rendre confidentielle ; ouvrir un document le
 * montre tel que les agents le lisent.
 */
export default function BaseView({ baseId, fallbackName, canWrite, onBack, onDeleted, onChanged }: Props) {
  const { t } = useI18n()
  const viewer = useDocumentViewer()
  const [detail, setDetail] = useState<LibraryBaseDetail | null>(null)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(0)
  const [renaming, setRenaming] = useState<'base' | string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [linking, setLinking] = useState(false)
  const [link, setLink] = useState('')
  const [moving, setMoving] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const refresh = useCallback(() => setVersion((current) => current + 1), [])

  useEffect(() => {
    let cancelled = false
    api
      .getLibraryBase(baseId)
      .then((next) => !cancelled && setDetail(next))
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : t('knowledge.failed.generic')))
    return () => {
      cancelled = true
    }
  }, [baseId, version, t])

  const working = detail?.sources.some((source) => source.status === 'pending' || source.status === 'processing') ?? false
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
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('knowledge.failed.generic'))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const folders = useMemo(() => detail?.folders ?? [], [detail])
  // Dossier ouvert supprimé entre-temps : retour à la racine.
  const openFolder = folderId && folders.some((folder) => folder.id === folderId) ? folderId : null
  const path = folderPath(folders, openFolder)
  const childFolders = folders.filter((folder) => folder.parentId === openFolder).sort((a, b) => a.name.localeCompare(b.name))
  const sources = (detail?.sources ?? []).filter((source) => (source.folderId ?? null) === openFolder)
  const base = detail?.base
  const canEdit = canWrite && Boolean(base && base.access !== 'view')
  const isOwner = base?.access === 'owner'
  const title = base?.name ?? fallbackName

  function addFiles(files: File[]) {
    if (!files.length) return
    if (files.some((file) => file.size > MAX_FILE_BYTES)) return setError(t('error.fileTooLarge'))
    void run(async () => {
      for (const file of files) await api.addLibraryFile(baseId, file, file.name, openFolder)
    })
  }

  function addLink() {
    const url = link.trim()
    if (!url) return
    void run(async () => {
      await api.addLibraryLink(baseId, url, openFolder)
      setLink('')
      setLinking(false)
    })
  }

  const statusOf = (source: KnowledgeSource) =>
    source.status === 'pending'
      ? t('knowledge.pending')
      : source.status === 'processing'
        ? t('knowledge.processing')
        : source.status === 'error'
          ? t(failureKey(source.errorCode))
          : t('knowledge.chunks', { count: formatNumber(source.chunkCount) })

  function open(source: KnowledgeSource) {
    const href = source.kind === 'link' && source.url ? safeHref(source.url) : null
    if (source.status === 'ready' && viewer) return viewer({ n: 0, sourceId: source.id, name: source.name, url: null, base: 'agent', excerpt: null })
    if (href) window.open(href, '_blank', 'noopener,noreferrer')
  }

  const confirm = (id: string, action: () => void) => {
    if (armed !== id) return setArmed(id)
    setArmed(null)
    action()
  }

  return (
    <div
      className={`list-panel library-base${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => {
        if (!canEdit || !event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event: DragEvent) => {
        event.preventDefault()
        setDragging(false)
        if (canEdit) addFiles([...event.dataTransfer.files])
      }}
    >
      <PanelBack label={t('library.back')} onClick={onBack} />
      {renaming === 'base' ? (
        <InlineEdit
          initial={title}
          label={t('common.rename')}
          icon={<BookOpen size={14} />}
          onSubmit={(name) => {
            setRenaming(null)
            void run(() => api.updateLibraryBase(baseId, { name }))
          }}
          onCancel={() => setRenaming(null)}
        />
      ) : (
        <div className="project-view-head">
          {base?.confidential ? <Lock size={16} /> : <BookOpen size={16} />}
          <strong title={title}>{title}</strong>
          {base && (
            <span className="list-section-actions">
              {canEdit && (
                <SectionAction label={t('common.rename')} onClick={() => setRenaming('base')}>
                  <Pencil size={13} />
                </SectionAction>
              )}
              {isOwner && (
                <SectionAction label={t('library.share')} pressed={sharing} onClick={() => setSharing(!sharing)}>
                  <Share2 size={13} />
                </SectionAction>
              )}
              {canEdit && (
                <SectionAction
                  label={`${t('knowledge.confidential')} — ${t('knowledge.confidentialHint')}`}
                  pressed={base.confidential}
                  disabled={busy}
                  onClick={() => void run(() => api.updateLibraryBase(baseId, { confidential: !base.confidential }))}
                >
                  {base.confidential ? <Lock size={13} /> : <LockOpen size={13} />}
                </SectionAction>
              )}
              {isOwner && (
                <button
                  type="button"
                  className={`projects-add-button${armed === 'base' ? ' armed' : ''}`}
                  aria-label={t('library.delete')}
                  title={armed === 'base' ? t('library.deleteConfirm') : t('library.delete')}
                  onBlur={() => setArmed(null)}
                  onClick={() =>
                    confirm(
                      'base',
                      () =>
                        void api
                          .deleteLibraryBase(baseId)
                          .then(onDeleted)
                          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('knowledge.failed.generic'))),
                    )
                  }
                >
                  <Trash2 size={13} />
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {base && !canEdit && <p className="settings-hint library-readonly">{t('library.readOnly')}</p>}
      {sharing && base && <SharePanel resource={{ type: 'knowledge_base', id: baseId, name: title }} onError={setError} />}
      {base?.confidential && (
        <p className="knowledge-note">
          <Lock size={11} /> {t('knowledge.confidentialHint')}
        </p>
      )}

      {/* À la racine, le titre suffit ; dans un dossier, le chemin pour remonter. */}
      {path.length > 0 && (
        <nav className="library-path" aria-label={t('library.path')}>
          <button type="button" aria-current={openFolder === null ? 'page' : undefined} onClick={() => setFolderId(null)}>
            {title}
          </button>
          {path.map((folder) => (
            <span key={folder.id} className="library-path-step">
              <ChevronRight size={11} aria-hidden="true" />
              <button type="button" aria-current={folder.id === openFolder ? 'page' : undefined} onClick={() => setFolderId(folder.id)}>
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      <ListSection
        label={path.at(-1)?.name ?? t('knowledge.documents')}
        ariaLabel={t('library.content')}
        actions={
          canEdit && (
            <>
              <SectionAction label={t('library.newFolder')} pressed={creatingFolder} onClick={() => setCreatingFolder(!creatingFolder)}>
                <FolderPlus size={13} />
              </SectionAction>
              {base?.linksEnabled && (
                <SectionAction label={t('knowledge.addLinkShort')} pressed={linking} onClick={() => setLinking(!linking)}>
                  <Link2 size={13} />
                </SectionAction>
              )}
              <SectionAction label={t('knowledge.addFile')} disabled={busy} onClick={() => fileRef.current?.click()}>
                <Upload size={13} />
              </SectionAction>
            </>
          )
        }
      >
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          aria-label={t('knowledge.addFile')}
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])])
            event.target.value = ''
          }}
        />
        {creatingFolder && (
          <InlineEdit
            initial=""
            label={t('library.folderName')}
            icon={<Folder size={14} />}
            onSubmit={(name) => {
              setCreatingFolder(false)
              void run(() => api.createKnowledgeFolder(baseId, name, openFolder))
            }}
            onCancel={() => setCreatingFolder(false)}
          />
        )}
        {linking && (
          <div className="knowledge-link">
            <Link2 size={13} />
            <input
              autoFocus
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
        {error && (
          <p className="knowledge-error" role="alert">
            {error}
          </p>
        )}

        {childFolders.length + sources.length > 0 ? (
          <ListRows label={t('library.content')}>
            {childFolders.map((folder) => {
              const inside = (detail?.sources ?? []).filter((source) => source.folderId === folder.id).length
              return renaming === folder.id ? (
                <li key={folder.id} className="list-row-wrap">
                  <InlineEdit
                    initial={folder.name}
                    label={t('common.rename')}
                    icon={<Folder size={14} />}
                    onSubmit={(name) => {
                      setRenaming(null)
                      void run(() => api.updateKnowledgeFolder(folder.id, { name }))
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                </li>
              ) : (
                <ListRow
                  key={folder.id}
                  icon={<Folder size={15} />}
                  title={folder.name}
                  label={t('library.openFolder', { name: folder.name })}
                  onClick={() => setFolderId(folder.id)}
                  trailing={<span className="list-row-chip muted">{inside}</span>}
                  actions={
                    canEdit ? (
                      <>
                        <RowAction label={t('common.rename')} onClick={() => setRenaming(folder.id)}>
                          <Pencil size={12} />
                        </RowAction>
                        <RowAction
                          label={armed === folder.id ? t('library.deleteFolderConfirm') : t('library.deleteFolder', { name: folder.name })}
                          armed={armed === folder.id}
                          onBlur={() => setArmed(null)}
                          onClick={() => confirm(folder.id, () => void run(() => api.deleteKnowledgeFolder(folder.id)))}
                        >
                          <X size={12} />
                        </RowAction>
                      </>
                    ) : undefined
                  }
                />
              )
            })}
            {sources.map((source) => {
              const loading = source.status === 'pending' || source.status === 'processing'
              const Icon = source.status === 'error' ? TriangleAlert : source.kind === 'link' ? Link2 : FileText
              return (
                <ListRow
                  key={source.id}
                  icon={loading ? <LoaderCircle size={14} className="spin" /> : <Icon size={14} className={source.status === 'error' ? 'knowledge-error-icon' : ''} />}
                  title={source.name}
                  tooltip={source.kind === 'link' ? (source.url ?? source.name) : source.name}
                  subtitle={statusOf(source)}
                  label={t('library.openDocument', { name: source.name })}
                  onClick={source.status === 'ready' || source.kind === 'link' ? () => open(source) : undefined}
                  actions={
                    canEdit ? (
                      <>
                        <RowAction label={t('library.move', { name: source.name })} expanded={moving === source.id} onClick={() => setMoving(moving === source.id ? null : source.id)}>
                          <FolderInput size={12} />
                        </RowAction>
                        {source.status === 'error' && failureKey(source.errorCode) !== 'knowledge.failed.format' && (
                          <RowAction label={t('knowledge.reindex')} onClick={() => void run(() => api.reindexKnowledgeSource(source.id))}>
                            <RefreshCw size={12} />
                          </RowAction>
                        )}
                        <RowAction
                          label={armed === source.id ? t('common.confirm') : t('knowledge.remove', { name: source.name })}
                          armed={armed === source.id}
                          onBlur={() => setArmed(null)}
                          onClick={() => confirm(source.id, () => void run(() => api.deleteKnowledgeSource(source.id)))}
                        >
                          <X size={12} />
                        </RowAction>
                      </>
                    ) : undefined
                  }
                >
                  {moving === source.id && (
                    <label className="library-move">
                      <FolderInput size={12} />
                      <select
                        autoFocus
                        aria-label={t('library.moveTo')}
                        value={source.folderId ?? ''}
                        onChange={(event) => {
                          setMoving(null)
                          void run(() => api.moveKnowledgeSource(source.id, event.target.value || null))
                        }}
                      >
                        <option value="">{t('library.root', { name: title })}</option>
                        {folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folderPath(folders, folder.id)
                              .map((step) => step.name)
                              .join(' › ')}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </ListRow>
              )
            })}
          </ListRows>
        ) : (
          detail && <ListEmpty>{canEdit ? t('library.emptyFolder') : t('knowledge.none')}</ListEmpty>
        )}

        {detail && detail.sources.length > 0 && (
          <p className="knowledge-mode">
            {detail.base.embeddingModel ? <Sparkles size={11} /> : <Search size={11} />}
            {detail.base.embeddingModel ? t('knowledge.semantic', { model: detail.base.embeddingModel.split(':').slice(1).join(':') }) : t('knowledge.keywords')}
          </p>
        )}
      </ListSection>
    </div>
  )
}
