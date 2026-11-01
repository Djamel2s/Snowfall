import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Lock } from 'lucide-react'
import { api, type Agent, type LibraryBaseSummary, type Project } from '../../lib/api'
import { libraryLabel } from '../../lib/library'
import { useI18n } from '../../lib/i18n'
import { InlineEdit, ListEmpty, ListRow, ListRows, ListSection, PanelNew, PanelSearch } from '../ui/List'
import BaseView from './BaseView'

type Props = {
  agents: Agent[]
  projects: Project[]
  canWrite: boolean
  /** Base à ouvrir (depuis un agent ou un projet). */
  openBaseId: string | null
  onOpenBase: (baseId: string | null) => void
}

/**
 * Bibliothèque de connaissances : les bases de l'utilisateur et celles
 * partagées avec lui. Une base se rattache ensuite à des agents et des projets.
 */
export default function LibraryPanel({ agents, projects, canWrite, openBaseId, onOpenBase }: Props) {
  const { t } = useI18n()
  const [bases, setBases] = useState<LibraryBaseSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((current) => current + 1), [])

  useEffect(() => {
    let cancelled = false
    api
      .listLibrary()
      .then((next) => !cancelled && setBases(next))
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [version])

  const label = (base: LibraryBaseSummary) => libraryLabel(base, agents, projects, t)

  if (openBaseId) {
    const known = bases?.find((base) => base.id === openBaseId)
    return (
      <BaseView
        key={openBaseId}
        baseId={openBaseId}
        fallbackName={known ? label(known) : t('library.untitled')}
        canWrite={canWrite}
        onBack={() => {
          onOpenBase(null)
          reload()
        }}
        onDeleted={() => {
          onOpenBase(null)
          reload()
        }}
        onChanged={reload}
      />
    )
  }

  const needle = query.trim().toLocaleLowerCase()
  const shown = (bases ?? []).filter((base) => !needle || label(base).toLocaleLowerCase().includes(needle))
  const mine = shown.filter((base) => base.mine)
  const shared = shown.filter((base) => !base.mine)

  const row = (base: LibraryBaseSummary) => {
    const users = base.usedBy.map((item) => (item.kind === 'agent' ? agents.find((agent) => agent.id === item.id)?.name : projects.find((project) => project.id === item.id)?.name)).filter(Boolean)
    const count = t(base.sourceCount === 1 ? 'library.documents.one' : 'library.documents.many', { count: base.sourceCount })
    return (
      <ListRow
        key={base.id}
        icon={base.confidential ? <Lock size={15} /> : <BookOpen size={15} />}
        title={label(base)}
        subtitle={users.length ? `${count} · ${t('library.usedBy', { names: users.join(', ') })}` : count}
        tooltip={label(base)}
        onClick={() => onOpenBase(base.id)}
        trailing={base.shared ? <span className="list-row-chip muted">{t('library.shared')}</span> : base.access === 'view' ? <span className="list-row-chip muted">{t('library.readOnlyChip')}</span> : undefined}
      />
    )
  }

  return (
    <div className="list-panel">
      {canWrite && <PanelNew label={t('library.new')} onClick={() => setCreating(true)} disabled={creating} />}
      <PanelSearch value={query} onChange={setQuery} placeholder={t('library.search')} />
      {creating && (
        <InlineEdit
          initial=""
          label={t('library.name')}
          icon={<BookOpen size={14} />}
          onSubmit={(name) => {
            setCreating(false)
            void api
              .createLibraryBase(name)
              .then((base) => {
                reload()
                onOpenBase(base.id)
              })
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {error && (
        <p className="knowledge-error" role="alert">
          {error}
        </p>
      )}
      <ListSection label={t('library.mine')}>{mine.length ? <ListRows>{mine.map(row)}</ListRows> : bases && <ListEmpty>{needle ? t('library.noMatch') : t('library.firstBase')}</ListEmpty>}</ListSection>
      {shared.length > 0 && (
        <ListSection label={t('library.sharedWithMe')}>
          <ListRows>{shared.map(row)}</ListRows>
        </ListSection>
      )}
      <p className="settings-hint">{t('library.hint')}</p>
    </div>
  )
}
