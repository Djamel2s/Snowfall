import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  MessageSquare,
  Trash2,
  LogOut,
  Bookmark,
  Folder,
  FolderInput,
  Bot,
  Settings,
  Pin,
  ChevronRight,
  Pencil,
  Check,
  MoreHorizontal,
  TextSearch,
  ScrollText,
  GraduationCap,
  Plug,
  Archive,
  ArrowLeft,
  ArchiveRestore,
  Tag,
  ShieldCheck,
} from 'lucide-react'
import type { Agent, Preferences, Project, Prompt, SearchHit } from '../lib/api'
import { useI18n } from '../lib/i18n'
import AgentStudio from './AgentStudio'
import AdminPanel from './AdminPanel'
import SettingsPanel from './SettingsPanel'
import AgentsPanel from './AgentsPanel'
import { useBranding } from '../lib/branding'
import { ListEmpty, ListRow, ListRows, ListSection, PanelBack, PanelNew, PanelSearch, SectionAction } from './ui/List'
import AgentSchedules from './AgentSchedules'
import PromptLibrary from './PromptLibrary'
import SkillLibrary from './SkillLibrary'
// Logos et catalogue chargés à l'ouverture du panneau seulement.
const ConnectorsPanel = lazy(() => import('./ConnectorsPanel'))
import KnowledgePanel from './KnowledgePanel'

export type SidebarPanel = 'chats' | 'pinned' | 'projects' | 'agents' | 'prompts' | 'skills' | 'connectors' | 'admin' | 'settings' | 'conversation'

export type SidebarConversation = {
  id: string
  title: string
  projectId: string | null
  /** Archivée : hors de l'historique, dans « Archivées ». */
  archived?: boolean
  tags?: string[]
}

type SidebarProps = {
  conversations: SidebarConversation[]
  visibleConversations: SidebarConversation[]
  projects: Project[]
  activeProjectId: string | null
  activeId: string | null
  username: string
  historyLoading: boolean
  creating: boolean
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  sidebarPanel: SidebarPanel
  /** Panneau « Cette conversation » (réglages, préréglages), fourni par l'application. */
  conversationPanel?: ReactNode
  search: string
  searchResults: SearchHit[]
  pinnedIds: string[]
  onNewChat: () => void
  onSelectConversation: (id: string) => void
  /** Conversation d'une tâche planifiée (la liste est relue d'abord). */
  onOpenSchedule: (conversationId: string) => void
  onDeleteConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onMoveConversation: (id: string, projectId: string | null) => void
  onTogglePinned: (id: string) => void
  onArchiveConversation: (id: string, archived: boolean) => void
  onLogout: () => void
  onSearchChange: (value: string) => void
  onSidebarOpenChange: (open: boolean) => void
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onSidebarPanelChange: (panel: SidebarPanel) => void
  onProjectSelect: (id: string | null) => void
  onCreateProject: (name: string) => void
  onRenameProject: (id: string, name: string) => void
  onDeleteProject: (id: string) => void
  agents: Agent[]
  activeAgentId: string | null
  /** undefined : éditeur fermé ; null : création ; Agent : modification. */
  agentEditor: Agent | null | undefined
  agentEditorNotice?: string
  onAgentEditorClose: () => void
  onAgentSaved: (agent: Agent, notice?: string, test?: boolean) => void
  /** Agent installé depuis le catalogue : liste rechargée, studio ouvert. */
  onTemplateInstalled: (agentId: string) => void
  onAgentDeleted: (id: string) => void
  onCreateAgent?: () => void
  onStartAgent: (agent: Agent) => void
  onEditAgent: (agent: Agent) => void
  onDuplicateAgent: (agent: Agent) => void
  /** Ouvre la carte des agents (graphe) dans la zone principale. */
  onOpenGraph: () => void
  onError: (message: string) => void
  /** Nom court du modèle d'un agent, pour le catalogue. */
  agentModelLabel: (agent: Agent) => string
  currentUserId: string
  preferences: Preferences
  onPreferencesChange: (preferences: Preferences) => void
  onPreferencesSave: (preferences: Preferences) => Promise<void>
  onConversationsImported: () => void
  prompts: Prompt[]
  canWrite: boolean
  /** Administrateur de l'organisation (catalogue des connecteurs). */
  isAdmin: boolean
  onPromptsChange: (prompts: Prompt[]) => void
  onUsePrompt: (prompt: Prompt) => void
  /** Retour d'une connexion OAuth à un outil externe. */
  connectionNotice?: string | undefined
  /** Connecteur auquel on vient de se connecter : sa fiche s'ouvre. */
  returnedServerId?: string | undefined
}

/** Champ de saisie en place (nouveau projet, renommage). */
function InlineEdit({
  initial,
  label,
  icon,
  onSubmit,
  onCancel,
}: {
  initial: string
  label: string
  icon: ReactNode
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <form
      className="project-draft"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = value.trim()
        if (trimmed && trimmed !== initial) onSubmit(trimmed)
        else onCancel()
      }}
    >
      {icon}
      <input
        autoFocus
        aria-label={label}
        placeholder={label}
        maxLength={120}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
        onBlur={() => !value.trim() && onCancel()}
        onFocus={(event) => event.target.select()}
      />
      <button type="submit" aria-label={label} disabled={!value.trim()}>
        <Check size={14} />
      </button>
    </form>
  )
}

export default function Sidebar(props: SidebarProps) {
  const {
    conversations,
    visibleConversations,
    projects,
    activeProjectId,
    activeId,
    username,
    historyLoading,
    creating,
    sidebarOpen,
    sidebarCollapsed,
    sidebarPanel,
    search,
    searchResults,
    pinnedIds,
    agents,
    activeAgentId,
    agentEditor,
  } = props
  const { t } = useI18n()
  const brand = useBranding()
  const [projectDraft, setProjectDraft] = useState(false)
  // Agent choisi pour planifier une tâche (formulaire ouvert dans la barre).
  const [projectQuery, setProjectQuery] = useState('')
  const [scheduling, setScheduling] = useState<Agent | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [movingFor, setMovingFor] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  // Rangement : vue des archivées, filtre par étiquette.
  const [showArchived, setShowArchived] = useState(false)
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuFor) return
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuFor(null)
        setMovingFor(null)
        setArmed(null)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuFor])

  // Recherche : partout (archivées comprises) ; sinon, l'étagère choisie.
  const archivedCount = visibleConversations.filter((conversation) => conversation.archived).length
  const archivedView = showArchived && archivedCount > 0
  const tags = [...new Set(visibleConversations.filter((conversation) => !conversation.archived).flatMap((conversation) => conversation.tags ?? []))].sort((a, b) => a.localeCompare(b))
  const activeTag = tagFilter && tags.includes(tagFilter) ? tagFilter : null
  const shelf = search
    ? visibleConversations
    : visibleConversations.filter(
        (conversation) => Boolean(conversation.archived) === archivedView && (!activeTag || conversation.tags?.includes(activeTag)),
      )
  const filteredConversations = shelf.filter((conversation) =>
    conversation.title.toLowerCase().includes(search.toLowerCase()),
  )
  const pinnedConversations = filteredConversations.filter((conversation) => pinnedIds.includes(conversation.id))
  const historyConversations = sidebarPanel === 'pinned' ? pinnedConversations : filteredConversations
  // Résultats serveur trouvés dans les messages, absents des titres affichés.
  const contentHits = searchResults.filter(
    (hit) => hit.snippet && !filteredConversations.some((conversation) => conversation.id === hit.id),
  )

  function closeMenu() {
    setMenuFor(null)
    setMovingFor(null)
    setArmed(null)
  }

  /** Projets : la liste (comme l'historique), puis la page d'un projet (ses conversations, ses documents). */
  function projectsPanel() {
    const project = projects.find((item) => item.id === activeProjectId)
    if (project) {
      return (
        <div className="list-panel project-view">
          <PanelBack label={t('sidebar.projectsBack')} onClick={() => props.onProjectSelect(null)} />
          {renamingProject === project.id ? (
            <InlineEdit
              initial={project.name}
              label={t('common.rename')}
              icon={<Folder size={14} />}
              onSubmit={(name) => {
                props.onRenameProject(project.id, name)
                setRenamingProject(null)
              }}
              onCancel={() => setRenamingProject(null)}
            />
          ) : (
            <div className="project-view-head">
              <Folder size={16} />
              <strong title={project.name} onDoubleClick={() => setRenamingProject(project.id)}>
                {project.name}
              </strong>
              <span className="list-section-actions">
                <SectionAction label={t('common.rename')} onClick={() => setRenamingProject(project.id)}>
                  <Pencil size={13} />
                </SectionAction>
                <button
                  type="button"
                  className={`projects-add-button${armed === project.id ? ' armed' : ''}`}
                  aria-label={t('sidebar.deleteProject')}
                  title={armed === project.id ? t('common.confirm') : t('sidebar.deleteProject')}
                  onBlur={() => setArmed(null)}
                  onClick={() => {
                    if (armed !== project.id) {
                      setArmed(project.id)
                      return
                    }
                    setArmed(null)
                    props.onDeleteProject(project.id)
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          )}
          <PanelNew label={creating ? t('sidebar.creating') : t('sidebar.newChat')} onClick={props.onNewChat} disabled={creating} />
          <PanelSearch value={search} onChange={props.onSearchChange} placeholder={t('sidebar.search')} label={t('sidebar.searchLabel')} />
          <ListSection label={t('sidebar.projectConversations')}>
            <div className="conversation-list">
              {filteredConversations.map((conversation) => conversationRow(conversation, <MessageSquare size={16} className="conversation-symbol" />))}
            </div>
            {!historyLoading && filteredConversations.length === 0 && <ListEmpty>{search ? t('sidebar.noResult') : t('sidebar.emptyProject')}</ListEmpty>}
          </ListSection>
          <KnowledgePanel kind="projects" ownerId={project.id} />
        </div>
      )
    }

    const needle = projectQuery.trim().toLocaleLowerCase()
    const shownProjects = needle ? projects.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : projects
    return (
      <div className="list-panel">
        <PanelNew label={t('sidebar.newProject')} onClick={() => setProjectDraft(true)} />
        <PanelSearch value={projectQuery} onChange={setProjectQuery} placeholder={t('sidebar.searchProjects')} />
        {projectDraft && (
          <InlineEdit
            initial=""
            label={t('sidebar.projectName')}
            icon={<Folder size={14} />}
            onSubmit={(name) => {
              props.onCreateProject(name)
              setProjectDraft(false)
            }}
            onCancel={() => setProjectDraft(false)}
          />
        )}
        <ListSection label={t('sidebar.projectsTitle')}>
          {shownProjects.length ? (
            <ListRows>
              {shownProjects.map((item) => {
                const count = conversations.filter((conversation) => conversation.projectId === item.id).length
                return (
                  <ListRow
                    key={item.id}
                    icon={<Folder size={15} />}
                    title={item.name}
                    tooltip={item.name}
                    onClick={() => props.onProjectSelect(item.id)}
                    trailing={<span className="list-row-chip muted">{count}</span>}
                  />
                )
              })}
            </ListRows>
          ) : (
            <ListEmpty>{needle ? t('sidebar.noResult') : t('sidebar.firstProject')}</ListEmpty>
          )}
        </ListSection>
      </div>
    )
  }

  function conversationRow(conversation: SidebarConversation, icon: ReactNode, child = false) {
    const isPinned = pinnedIds.includes(conversation.id)

    if (renaming === conversation.id) {
      return (
        <InlineEdit
          key={conversation.id}
          initial={conversation.title}
          label={t('common.rename')}
          icon={<Pencil size={14} />}
          onSubmit={(title) => {
            props.onRenameConversation(conversation.id, title)
            setRenaming(null)
          }}
          onCancel={() => setRenaming(null)}
        />
      )
    }

    return (
      <div
        className={`${child ? 'conversation-project-item child' : 'conversation-item'} ${
          conversation.id === activeId ? 'selected' : ''
        } ${menuFor === conversation.id ? 'menu-open' : ''}`}
        key={conversation.id}
      >
        <button
          className="conversation-select"
          title={conversation.title}
          type="button"
          onClick={() => props.onSelectConversation(conversation.id)}
          onDoubleClick={() => setRenaming(conversation.id)}
        >
          {icon}
          <span className="conversation-title">{conversation.title}</span>
        </button>

        <button
          className="conversation-delete"
          type="button"
          aria-label={conversation.title}
          aria-haspopup="menu"
          aria-expanded={menuFor === conversation.id}
          onClick={() => (menuFor === conversation.id ? closeMenu() : setMenuFor(conversation.id))}
        >
          <MoreHorizontal size={15} />
        </button>

        {menuFor === conversation.id && (
          <div className="conversation-menu" role="menu" ref={menuRef}>
            {movingFor === conversation.id ? (
              <>
                {[{ id: null, name: t('sidebar.noProject') }, ...projects].map((project) => (
                  <button
                    key={project.id ?? 'none'}
                    type="button"
                    role="menuitemradio"
                    aria-checked={conversation.projectId === project.id}
                    onClick={() => {
                      props.onMoveConversation(conversation.id, project.id)
                      closeMenu()
                    }}
                  >
                    <Folder size={14} />
                    <span>{project.name}</span>
                    {conversation.projectId === project.id && <Check size={13} />}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button type="button" role="menuitem" onClick={() => { setRenaming(conversation.id); closeMenu() }}>
                  <Pencil size={14} />
                  <span>{t('common.rename')}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => setMovingFor(conversation.id)}>
                  <FolderInput size={14} />
                  <span>{t('sidebar.moveToProject')}</span>
                  <ChevronRight size={13} />
                </button>
                <button type="button" role="menuitem" onClick={() => { props.onArchiveConversation(conversation.id, !conversation.archived); closeMenu() }}>
                  {conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  <span>{conversation.archived ? t('archive.restore') : t('archive.archive')}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => { props.onTogglePinned(conversation.id); closeMenu() }}>
                  {isPinned ? <Bookmark size={14} fill="currentColor" /> : <Pin size={14} />}
                  <span>{isPinned ? t('sidebar.unpin') : t('sidebar.pin')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`danger ${armed === conversation.id ? 'armed' : ''}`}
                  onClick={() => {
                    if (armed !== conversation.id) {
                      setArmed(conversation.id)
                      return
                    }
                    props.onDeleteConversation(conversation.id)
                    closeMenu()
                  }}
                >
                  <Trash2 size={14} />
                  <span>{armed === conversation.id ? t('common.confirm') : t('common.delete')}</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Toujours présent : il apparaît et disparaît en fondu (inerte une fois fermé). */}
      <button
        type="button"
        className={`mobile-scrim${sidebarOpen ? ' open' : ''}`}
        aria-label={t('sidebar.menuClose')}
        aria-hidden={!sidebarOpen}
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => props.onSidebarOpenChange(false)}
      />

      <aside
        className={['sidebar', sidebarOpen ? 'sidebar-open' : '', sidebarCollapsed ? 'sidebar-collapsed' : '']
          .filter(Boolean)
          .join(' ')}
      >
        <nav className="sidebar-rail" aria-label={t('sidebar.navigation')}>
          <button
            className="rail-brand"
            title="Snowfall"
            aria-label="Snowfall"
            onClick={() => {
              // Téléphone : le logo referme le menu ; ordinateur : il replie la barre.
              if (sidebarOpen && window.matchMedia('(max-width: 620px)').matches) props.onSidebarOpenChange(false)
              else props.onSidebarCollapsedChange(!sidebarCollapsed)
            }}
          >
            <span className="brand-icon">
              <img src={brand.logo} alt="Snowfall" className="snowfall-logo" />
            </span>
          </button>

          <div className="rail-divider" />

          {(
            [
              { id: 'chats', label: t('sidebar.chats'), icon: MessageSquare },
              { id: 'projects', label: t('sidebar.projects'), icon: Folder },
              { id: 'agents', label: t('sidebar.agents'), icon: Bot },
              { id: 'prompts', label: t('prompts.title'), icon: ScrollText },
              { id: 'skills', label: t('skills.title'), icon: GraduationCap },
              { id: 'connectors', label: t('connectors.title'), icon: Plug },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`rail-action ${sidebarPanel === id ? 'rail-action-active' : ''}`}
              title={label}
              aria-label={label}
              aria-current={sidebarPanel === id ? 'page' : undefined}
              onClick={() => {
                // Naviguer ferme le studio d'agent resté ouvert, même vers la section d'où il s'est ouvert.
                if (agentEditor !== undefined) props.onAgentEditorClose()
                // Le tiroir reste ouvert (mobile) : on veut voir la section choisie.
                props.onSidebarPanelChange(id)
              }}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span className="rail-tooltip">{label}</span>
            </button>
          ))}

          <div className="rail-spacer" />

          {/* Administration de l'organisation : administrateurs seulement (l'API refuse aussi). */}
          {props.isAdmin && (
            <button
              className={`rail-action ${sidebarPanel === 'admin' ? 'rail-action-active' : ''}`}
              title={t('sidebar.admin')}
              aria-label={t('sidebar.admin')}
              aria-current={sidebarPanel === 'admin' ? 'page' : undefined}
              onClick={() => {
                if (agentEditor !== undefined) props.onAgentEditorClose()
                props.onSidebarPanelChange('admin')
                props.onSidebarCollapsedChange(false)
              }}
            >
              <ShieldCheck size={19} strokeWidth={1.8} />
              <span className="rail-tooltip">{t('sidebar.admin')}</span>
            </button>
          )}

          <button
            className={`rail-action ${sidebarPanel === 'settings' ? 'rail-action-active' : ''}`}
            title={t('sidebar.settings')}
            aria-label={t('sidebar.settings')}
            aria-current={sidebarPanel === 'settings' ? 'page' : undefined}
            onClick={() => {
              if (agentEditor !== undefined) props.onAgentEditorClose()
              props.onSidebarPanelChange('settings')
              props.onSidebarCollapsedChange(false)
            }}
          >
            <Settings size={19} strokeWidth={1.8} />
            <span className="rail-tooltip">{t('sidebar.settings')}</span>
          </button>
        </nav>

        <div className="sidebar-panel">
          <header className="sidebar-panel-header">
            <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
              <span className="brand-word">Snowfall</span>
              {/* Organisation : discrète, à côté du produit. */}
              {brand.name && (
                <span className="brand-org" title={brand.name}>
                  {brand.name}
                </span>
              )}
            </a>
          </header>

          {agentEditor !== undefined ? (
            <AgentStudio
              key={agentEditor?.id ?? 'new'}
              agent={agentEditor}
              agents={props.agents}
              notice={props.agentEditorNotice}
              onClose={props.onAgentEditorClose}
              onSaved={props.onAgentSaved}
              onDeleted={props.onAgentDeleted}
            />
          ) : sidebarPanel === 'conversation' && props.conversationPanel ? (
            props.conversationPanel
          ) : sidebarPanel === 'connectors' ? (
            <Suspense fallback={null}>
              <ConnectorsPanel key={props.returnedServerId ?? 'list'} isAdmin={props.isAdmin} notice={props.connectionNotice} returnedServerId={props.returnedServerId} onError={props.onError} />
            </Suspense>
          ) : sidebarPanel === 'skills' ? (
            <SkillLibrary canWrite={props.canWrite} />
          ) : sidebarPanel === 'prompts' ? (
            <PromptLibrary prompts={props.prompts} canWrite={props.canWrite} onChange={props.onPromptsChange} onUse={props.onUsePrompt} />
          ) : sidebarPanel === 'admin' && props.isAdmin ? (
            <AdminPanel />
          ) : sidebarPanel === 'settings' ? (
            <SettingsPanel preferences={props.preferences} onPreferencesChange={props.onPreferencesChange} onPreferencesSave={props.onPreferencesSave} onConversationsImported={props.onConversationsImported} />
          ) : sidebarPanel === 'agents' ? (
            <AgentsPanel
              agents={agents}
              activeAgentId={activeAgentId}
              currentUserId={props.currentUserId}
              modelLabel={props.agentModelLabel}
              canWrite={props.canWrite}
              onStart={props.onStartAgent}
              onEdit={props.onEditAgent}
              onDuplicate={props.onDuplicateAgent}
              onCreate={props.onCreateAgent}
              onSchedule={props.canWrite ? setScheduling : undefined}
              onOpenGraph={props.onOpenGraph}
              onTemplateInstalled={props.onTemplateInstalled}
              onError={props.onError}
              schedules={<AgentSchedules agents={agents} scheduling={scheduling} onCloseForm={() => setScheduling(null)} onOpen={props.onOpenSchedule} onError={props.onError} />}
            />
          ) : sidebarPanel === 'projects' ? (
            projectsPanel()
          ) : (
            <>
              <PanelNew label={creating ? t('sidebar.creating') : t('sidebar.newChat')} onClick={props.onNewChat} disabled={creating} />
              <PanelSearch value={search} onChange={props.onSearchChange} placeholder={t('sidebar.search')} label={t('sidebar.searchLabel')} />

                <>
                  {sidebarPanel === 'chats' && !search && tags.length > 0 && !archivedView && (
                    <div className="sidebar-tags" role="group" aria-label={t('tags.filter')}>
                      {tags.map((tag) => (
                        <button key={tag} type="button" className="sidebar-tag" aria-pressed={activeTag === tag} onClick={() => setTagFilter(activeTag === tag ? null : tag)}>
                          <Tag size={11} />
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}

                  {sidebarPanel === 'chats' && !search && !archivedView && !activeTag && (
                    <section className="sidebar-group">
                      <div className="sidebar-section-label">{t('sidebar.pinned')}</div>
                      {pinnedConversations.map((conversation) =>
                        conversationRow(conversation, <Pin size={15} className="conversation-symbol" />),
                      )}
                      {!historyLoading && pinnedConversations.length === 0 && (
                        <p className="empty-search">{t('sidebar.noPinned')}</p>
                      )}
                    </section>
                  )}

                  <div className="sidebar-section-label">
                    {sidebarPanel === 'pinned' ? t('sidebar.allPinned') : archivedView ? t('archive.title') : activeTag ?? t('sidebar.history')}
                  </div>

                  <div className="conversation-list">
                    {historyLoading && <p className="empty-search">{t('sidebar.loadingHistory')}</p>}

                    {!historyLoading &&
                      historyConversations.map((conversation) =>
                        conversationRow(conversation, <MessageSquare size={16} className="conversation-symbol" />),
                      )}

                    {!historyLoading && historyConversations.length === 0 && contentHits.length === 0 && (
                      <p className="empty-search">
                        {sidebarPanel === 'pinned'
                          ? t('sidebar.noPinned')
                          : search
                            ? t('sidebar.noResult')
                            : t('sidebar.noConversation')}
                      </p>
                    )}

                    {sidebarPanel === 'chats' && !search && archivedCount > 0 && (
                      <button type="button" className="sidebar-archived-toggle" aria-pressed={archivedView} onClick={() => setShowArchived(!archivedView)}>
                        {archivedView ? <ArrowLeft size={14} /> : <Archive size={14} />}
                        <span>{archivedView ? t('archive.back') : t('archive.show', { count: archivedCount })}</span>
                      </button>
                    )}

                    {contentHits.length > 0 && (
                      <>
                        <div className="sidebar-section-label">{t('sidebar.inMessages')}</div>
                        {contentHits.map((hit) => (
                          <button
                            key={hit.id}
                            type="button"
                            className={`search-hit ${hit.id === activeId ? 'selected' : ''}`}
                            onClick={() => props.onSelectConversation(hit.id)}
                          >
                            <TextSearch size={14} className="conversation-symbol" />
                            <span>
                              <strong>{hit.title}</strong>
                              <small>{hit.snippet}</small>
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </>
            </>
          )}

          <footer className="sidebar-bottom">
            <div className="account-row">
              <div className="user-avatar">
                <img src={brand.logo} alt="" className="user-avatar-logo" />
              </div>

              <div className="account-info">
                <strong>{username}</strong>
                <span>{t('sidebar.session')}</span>
              </div>

              <button
                className="account-menu"
                onClick={props.onLogout}
                aria-label={t('sidebar.logout')}
                title={t('sidebar.logout')}
              >
                <LogOut size={17} />
              </button>
            </div>
          </footer>
        </div>
      </aside>
    </>
  )
}
