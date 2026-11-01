import { useEffect, useState } from 'react'
import { ArrowUp, BookOpen, ExternalLink, Lock, Plus, X } from 'lucide-react'
import { api, ApiError, type Agent, type KnowledgeOwnerKind, type LibraryBase, type LibraryBaseSummary, type Project } from '../../lib/api'
import { libraryLabel } from '../../lib/library'
import { useI18n } from '../../lib/i18n'
import { InlineEdit, ListEmpty, ListRow, ListRows, ListSection, RowAction, SectionAction } from '../ui/List'

type Props = {
  kind: KnowledgeOwnerKind
  /** Absent : agent pas encore créé ; le choix est gardé par le parent (draft). */
  ownerId?: string | undefined
  draft?: string[]
  onDraftChange?: (baseIds: string[]) => void
  agents: Pick<Agent, 'id' | 'name'>[]
  projects: Pick<Project, 'id' | 'name'>[]
  /** Ouvre une base dans la bibliothèque. */
  onOpenBase?: ((baseId: string) => void) | undefined
}

/**
 * Bases de connaissances d'un agent ou d'un projet : celles de la bibliothèque
 * qu'on y rattache (plusieurs, dans l'ordre ; la première reçoit les notes de
 * l'agent). Rattacher une base à un agent partagé la rend lisible par ses
 * utilisateurs : il faut pouvoir la modifier (la base de données le vérifie).
 */
export default function BasePicker({ kind, ownerId, draft, onDraftChange, agents, projects, onOpenBase }: Props) {
  const { t } = useI18n()
  const [attached, setAttached] = useState<LibraryBase[] | null>(null)
  const [canManage, setCanManage] = useState(!ownerId)
  const [library, setLibrary] = useState<LibraryBaseSummary[]>([])
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.listLibrary(), ownerId ? api.getAttachedBases(kind, ownerId) : Promise.resolve(null)])
      .then(([found, current]) => {
        if (cancelled) return
        setLibrary(found)
        if (current) {
          setAttached(current.bases)
          setCanManage(current.canManage)
        }
      })
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [kind, ownerId])

  // Brouillon : les bases choisies viennent du parent, retrouvées dans la bibliothèque.
  const current: LibraryBase[] = ownerId ? (attached ?? []) : (draft ?? []).map((id) => library.find((base) => base.id === id)).filter((base): base is LibraryBaseSummary => Boolean(base))
  const label = (base: LibraryBase) => libraryLabel({ ...base, usedBy: library.find((item) => item.id === base.id)?.usedBy ?? [] }, agents, projects, t)
  // Rattachables : celles qu'on peut modifier (agent) ou lire (projet), pas déjà là.
  const choices = library.filter((base) => !current.some((item) => item.id === base.id) && (kind === 'projects' || base.access !== 'view'))

  async function save(ids: string[]) {
    if (!ownerId) return onDraftChange?.(ids)
    setError('')
    setBusy(true)
    try {
      setAttached(await api.setAttachedBases(kind, ownerId, ids))
    } catch (cause) {
      // Message de l'API déjà traduit (base confidentielle, etc.) ; 403 : un droit manque sur la base.
      setError(cause instanceof ApiError && cause.status === 403 ? t('library.attachForbidden') : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const ids = current.map((base) => base.id)
  return (
    <ListSection
      label={t('library.attached')}
      ariaLabel={t('library.attached')}
      actions={
        canManage && (
          <SectionAction label={t('library.attach')} pressed={adding} disabled={busy} onClick={() => setAdding(!adding)}>
            <Plus size={13} />
          </SectionAction>
        )
      }
    >
      {adding && (
        <div className="library-attach">
          <select
            autoFocus
            aria-label={t('library.attach')}
            value=""
            onChange={(event) => {
              const value = event.target.value
              if (value === 'new') return (setCreating(true), setAdding(false))
              setAdding(false)
              if (value) void save([...ids, value])
            }}
          >
            <option value="">{t('library.choose')}</option>
            {choices.map((base) => (
              <option key={base.id} value={base.id}>
                {label(base)}
              </option>
            ))}
            <option value="new">{t('library.newOption')}</option>
          </select>
        </div>
      )}
      {creating && (
        <InlineEdit
          initial=""
          label={t('library.name')}
          icon={<BookOpen size={14} />}
          onSubmit={(name) => {
            setCreating(false)
            void api
              .createLibraryBase(name)
              .then(async (base) => {
                setLibrary(await api.listLibrary())
                await save([...ids, base.id])
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
      {current.length ? (
        <ListRows>
          {current.map((base, index) => (
            <ListRow
              key={base.id}
              icon={base.confidential ? <Lock size={14} /> : <BookOpen size={14} />}
              title={label(base)}
              subtitle={index === 0 && kind === 'agents' && current.length > 1 ? t('library.primary') : base.access === 'view' ? t('library.readOnlyChip') : undefined}
              label={t('library.openBase', { name: label(base) })}
              onClick={onOpenBase ? () => onOpenBase(base.id) : undefined}
              actions={
                <>
                  {onOpenBase && (
                    <RowAction label={t('library.openBase', { name: label(base) })} onClick={() => onOpenBase(base.id)}>
                      <ExternalLink size={12} />
                    </RowAction>
                  )}
                  {canManage && index > 0 && (
                    <RowAction label={t('library.moveUp', { name: label(base) })} onClick={() => void save([base.id, ...ids.filter((id) => id !== base.id)])}>
                      <ArrowUp size={12} />
                    </RowAction>
                  )}
                  {canManage && (
                    <RowAction label={t('library.detach', { name: label(base) })} onClick={() => void save(ids.filter((id) => id !== base.id))}>
                      <X size={12} />
                    </RowAction>
                  )}
                </>
              }
            />
          ))}
        </ListRows>
      ) : (
        <ListEmpty>{canManage ? t('library.noneAttached') : t('knowledge.none')}</ListEmpty>
      )}
    </ListSection>
  )
}
