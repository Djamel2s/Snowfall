import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Plus,
  Search,
  MessageSquare,
  Trash2,
  LogOut,
  Bookmark,
  Folder,
  FolderInput,
  Bot,
  Settings,
  Pin,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Pencil,
  Check,
  MoreHorizontal,
  TextSearch,
} from 'lucide-react'
import type { Agent, Preferences, Project, SearchHit } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { AgentAvatar, ProviderLogo } from './AgentAvatar'
import AgentStudio from './AgentStudio'
import SettingsPanel from './SettingsPanel'

export type SidebarPanel = 'chats' | 'pinned' | 'projects' | 'agents' | 'settings'

export type SidebarConversation = {
  id: string
  title: string
  projectId: string | null
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
  search: string
  searchResults: SearchHit[]
  pinnedIds: string[]
  onNewChat: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onMoveConversation: (id: string, projectId: string | null) => void
  onTogglePinned: (id: string) => void
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
  onAgentEditorClose: () => void
  onAgentSaved: (agent: Agent) => void
  onAgentDeleted: (id: string) => void
  onCreateAgent?: () => void
  onStartAgent: (agent: Agent) => void
  onEditAgent: (agent: Agent) => void
  preferences: Preferences
  onPreferencesChange: (preferences: Preferences) => void
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
  const [projectDraft, setProjectDraft] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [movingFor, setMovingFor] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
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

  const filteredConversations = visibleConversations.filter((conversation) =>
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
      {sidebarOpen && (
        <button
          className="mobile-scrim"
          aria-label={t('sidebar.menuClose')}
          onClick={() => props.onSidebarOpenChange(false)}
        />
      )}

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
            onClick={() => props.onSidebarCollapsedChange(!sidebarCollapsed)}
          >
            <span className="brand-icon">
              <img src="/logo.png" alt="Snowfall" className="snowfall-logo" />
            </span>
          </button>

          <div className="rail-divider" />

          {(
            [
              { id: 'chats', label: t('sidebar.chats'), icon: MessageSquare },
              { id: 'projects', label: t('sidebar.projects'), icon: Folder },
              { id: 'agents', label: t('sidebar.agents'), icon: Bot },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`rail-action ${sidebarPanel === id ? 'rail-action-active' : ''}`}
              title={label}
              aria-label={label}
              aria-current={sidebarPanel === id ? 'page' : undefined}
              onClick={() => {
                // Changer de section ferme le créateur d'agent resté ouvert.
                if (agentEditor !== undefined && id !== sidebarPanel) props.onAgentEditorClose()
                props.onSidebarPanelChange(id)
                props.onSidebarOpenChange(false)
              }}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span className="rail-tooltip">{label}</span>
            </button>
          ))}

          <div className="rail-spacer" />

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
            </a>
          </header>

          {agentEditor !== undefined ? (
            <AgentStudio
              key={agentEditor?.id ?? 'new'}
              agent={agentEditor}
              onClose={props.onAgentEditorClose}
              onSaved={props.onAgentSaved}
              onDeleted={props.onAgentDeleted}
            />
          ) : sidebarPanel === 'settings' ? (
            <SettingsPanel preferences={props.preferences} onPreferencesChange={props.onPreferencesChange} />
          ) : (
            <>
              <button className="new-chat-button" onClick={props.onNewChat} disabled={creating}>
                <Plus size={17} />
                <span>{creating ? t('sidebar.creating') : t('sidebar.newChat')}</span>
              </button>

              <label className="search-box">
                <Search size={16} />
                <input
                  aria-label={t('sidebar.searchLabel')}
                  placeholder={t('sidebar.search')}
                  value={search}
                  onChange={(event) => props.onSearchChange(event.target.value)}
                />
                {search && (
                  <button
                    className="search-clear"
                    type="button"
                    aria-label={t('sidebar.searchClear')}
                    onClick={() => props.onSearchChange('')}
                  >
                    ×
                  </button>
                )}
              </label>

              {sidebarPanel === 'projects' ? (
                <div className="projects-panel">
                  <div className="sidebar-section-label projects-heading">
                    <span>{t('sidebar.projectsTitle')}</span>
                    <button
                      className="projects-add-button"
                      type="button"
                      onClick={() => setProjectDraft(true)}
                      aria-label={t('sidebar.createProject')}
                      title={t('sidebar.createProject')}
                    >
                      <Plus size={15} />
                    </button>
                  </div>

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

                  <div className="project-tree">
                    {projects.map((project) => {
                      const isActive = activeProjectId === project.id
                      const count = conversations.filter((item) => item.projectId === project.id).length

                      return (
                        <div className={`project-node ${isActive ? 'expanded' : ''}`} key={project.id}>
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
                            <div className="project-row">
                              <button
                                className={`project-item ${isActive ? 'selected' : ''}`}
                                type="button"
                                aria-expanded={isActive}
                                onClick={() => props.onProjectSelect(isActive ? null : project.id)}
                                onDoubleClick={() => setRenamingProject(project.id)}
                              >
                                {isActive ? (
                                  <ChevronDown size={14} className="project-chevron" />
                                ) : (
                                  <ChevronRight size={14} className="project-chevron" />
                                )}
                                <Folder size={15} />
                                <span className="project-name">{project.name}</span>
                                <small>{count}</small>
                              </button>
                              {isActive && (
                                <div className="project-actions">
                                  <button
                                    type="button"
                                    aria-label={t('common.rename')}
                                    title={t('common.rename')}
                                    onClick={() => setRenamingProject(project.id)}
                                  >
                                    <Pencil size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    className={armed === project.id ? 'armed' : ''}
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
                                </div>
                              )}
                            </div>
                          )}

                          {isActive && (
                            <div className="project-children">
                              {filteredConversations.map((conversation) =>
                                conversationRow(conversation, <CornerDownRight size={14} className="conversation-symbol" />, true),
                              )}
                              {!historyLoading && filteredConversations.length === 0 && (
                                <p className="empty-search child">{t('sidebar.emptyProject')}</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {projects.length === 0 && !projectDraft && (
                    <div className="projects-empty">
                      <Folder size={22} />
                      <strong>{t('sidebar.firstProject')}</strong>
                    </div>
                  )}
                </div>
              ) : sidebarPanel === 'chats' || sidebarPanel === 'pinned' ? (
                <>
                  {sidebarPanel === 'chats' && !search && (
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
                    {sidebarPanel === 'pinned' ? t('sidebar.allPinned') : t('sidebar.history')}
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
              ) : (
                <div className="projects-panel">
                  <div className="sidebar-section-label projects-heading">
                    <span>{t('sidebar.agentsTitle')}</span>
                    <button
                      className="projects-add-button"
                      type="button"
                      onClick={props.onCreateAgent}
                      disabled={!props.onCreateAgent}
                      aria-label={t('sidebar.createAgent')}
                      title={t('sidebar.createAgent')}
                    >
                      <Plus size={15} />
                    </button>
                  </div>

                  {agents.length === 0 ? (
                    <div className="projects-empty">
                      <Bot size={22} />
                      <strong>{t('sidebar.firstAgent')}</strong>
                    </div>
                  ) : (
                    <div className="agent-list">
                      {agents.map((agent) => (
                        <div key={agent.id} className={`agent-item ${agent.id === activeAgentId ? 'active' : ''}`}>
                          <button
                            type="button"
                            className="agent-item-main"
                            title={agent.name}
                            onClick={() => props.onStartAgent(agent)}
                          >
                            <AgentAvatar avatar={agent.avatar} size={30} />
                            <span className="agent-item-name">{agent.name}</span>
                            <ProviderLogo provider={agent.provider} size={12} />
                          </button>
                          {agent.canEdit && (
                            <button
                              type="button"
                              className="agent-item-edit"
                              aria-label={t('sidebar.editAgent', { name: agent.name })}
                              onClick={() => props.onEditAgent(agent)}
                            >
                              <Pencil size={13} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <footer className="sidebar-bottom">
            <div className="account-row">
              <div className="user-avatar">{username.slice(0, 1).toUpperCase() || '?'}</div>

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
