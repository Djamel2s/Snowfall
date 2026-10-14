import { useState } from 'react'
import {
  Plus,
  Search,
  MessageSquare,
  Trash2,
  LogOut,
  Bookmark,
  Folder,
  Bot,
  Settings,
  Pin,
  X,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Pencil,
  Check,
} from 'lucide-react'
import type { Agent } from '../lib/api'
import { AgentAvatar, ProviderLogo } from './AgentAvatar'
import AgentStudio from './AgentStudio'
import type { Project } from '../App'

export type SidebarPanel = 'chats' | 'pinned' | 'projects' | 'agents'

export type SidebarConversation = {
  id: string
  title: string
}

type SidebarProps = {
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
  pinnedIds: string[]
  onNewChat: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onTogglePinned: (id: string) => void
  onLogout: () => void
  onSearchChange: (value: string) => void
  onSidebarOpenChange: (open: boolean) => void
  onSidebarCollapsedChange: (collapsed: boolean) => void
  onSidebarPanelChange: (panel: SidebarPanel) => void
  onProjectSelect: (id: string | null) => void
  onCreateProject: (name: string) => void
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
  onSettings: () => void
}

export default function Sidebar({
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
  pinnedIds,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onTogglePinned,
  onLogout,
  onSearchChange,
  onSidebarOpenChange,
  onSidebarCollapsedChange,
  onSidebarPanelChange,
  onProjectSelect,
  onCreateProject,
  agents,
  activeAgentId,
  agentEditor,
  onAgentEditorClose,
  onAgentSaved,
  onAgentDeleted,
  onCreateAgent,
  onStartAgent,
  onEditAgent,
  onSettings,
}: SidebarProps) {
  const [projectDraft, setProjectDraft] = useState<string | null>(null)

  function submitProject() {
    const name = projectDraft?.trim()
    if (name) onCreateProject(name)
    setProjectDraft(null)
  }
  const filteredConversations = visibleConversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(search.toLowerCase()),
  )

  const pinnedConversations = filteredConversations.filter((conversation) =>
    pinnedIds.includes(conversation.id),
  )

  const historyConversations =
    sidebarPanel === 'pinned'
      ? pinnedConversations
      : filteredConversations

  return (
    <>
      {sidebarOpen && (
        <button
          className="mobile-scrim"
          aria-label="Fermer le menu"
          onClick={() => onSidebarOpenChange(false)}
        />
      )}

      <aside
        className={[
          'sidebar',
          sidebarOpen ? 'sidebar-open' : '',
          sidebarCollapsed ? 'sidebar-collapsed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <nav className="sidebar-rail" aria-label="Navigation principale">
          <button
            className="rail-brand"
            title="Snowfall"
            aria-label="Snowfall"
            onClick={() => onSidebarCollapsedChange(!sidebarCollapsed)}
          >
            <span className="brand-icon">
              <img
                src="/logo.png"
                alt="Snowfall"
                className="snowfall-logo"
                />
            </span>
          </button>

          <div className="rail-divider" />

          {(
            [
              { id: 'chats', label: 'Conversations', icon: MessageSquare },
              { id: 'projects', label: 'Projets', icon: Folder },
              { id: 'agents', label: 'Agents', icon: Bot },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`rail-action ${
                sidebarPanel === id ? 'rail-action-active' : ''
              }`}
              title={label}
              aria-label={label}
              aria-current={sidebarPanel === id ? 'page' : undefined}
              onClick={() => {
                // Changer de section ferme le créateur d'agent resté ouvert.
                if (agentEditor !== undefined && id !== sidebarPanel) onAgentEditorClose()
                onSidebarPanelChange(id)
                onSidebarOpenChange(false)
              }}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span className="rail-tooltip">{label}</span>
            </button>
          ))}

          <div className="rail-spacer" />

          <button
            className="rail-action"
            title="Paramètres"
            aria-label="Paramètres"
            onClick={onSettings}
          >
            <Settings size={19} strokeWidth={1.8} />
            <span className="rail-tooltip">Paramètres</span>
          </button>
        </nav>

        <div className="sidebar-panel">
          <header className="sidebar-panel-header">
            <a
              className="brand"
              href="#"
              onClick={(event) => event.preventDefault()}
            >
              <span className="brand-word">
                Snowfall
              </span>
            </a>
          </header>

          {agentEditor !== undefined ? (
            <AgentStudio
              key={agentEditor?.id ?? 'new'}
              agent={agentEditor}
              onClose={onAgentEditorClose}
              onSaved={onAgentSaved}
              onDeleted={onAgentDeleted}
            />
          ) : (
          <>
          <button
            className="new-chat-button"
            onClick={onNewChat}
            disabled={creating}
          >
            <Plus size={17} />
            <span>
              {creating ? 'Création…' : 'Nouvelle conversation'}
            </span>
          </button>

          <label className="search-box">
            <Search size={16} />
            <input
              aria-label="Rechercher une conversation"
              placeholder="Rechercher"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
            {search && (
              <button
                className="search-clear"
                type="button"
                aria-label="Effacer la recherche"
                onClick={() => onSearchChange('')}
              >
                ×
              </button>
            )}
          </label>

          {sidebarPanel === 'projects' ? (
            <div className="projects-panel">
                <div className="sidebar-section-label projects-heading">
                <span>PROJETS</span>
                <button
                    className="projects-add-button"
                    type="button"
                    onClick={() => setProjectDraft('')}
                    aria-label="Créer un projet"
                    title="Créer un projet"
                >
                    <Plus size={15} />
                </button>
                </div>

                {projectDraft !== null && (
                  <form
                    className="project-draft"
                    onSubmit={(event) => {
                      event.preventDefault()
                      submitProject()
                    }}
                  >
                    <Folder size={14} />
                    <input
                      autoFocus
                      aria-label="Nom du projet"
                      placeholder="Nom du projet"
                      maxLength={80}
                      value={projectDraft}
                      onChange={(event) => setProjectDraft(event.target.value)}
                      onKeyDown={(event) => event.key === 'Escape' && setProjectDraft(null)}
                      onBlur={() => !projectDraft.trim() && setProjectDraft(null)}
                    />
                    <button type="submit" aria-label="Créer" disabled={!projectDraft.trim()}>
                      <Check size={14} />
                    </button>
                  </form>
                )}

                <div className="project-tree">
                {projects.map((project) => {
                    const isActive = activeProjectId === project.id

                    return (
                    <div className={`project-node ${isActive ? 'expanded' : ''}`} key={project.id}>
                        <button
                        className={`project-item ${isActive ? 'selected' : ''}`}
                        type="button"
                        aria-expanded={isActive}
                        onClick={() => onProjectSelect(project.id)}
                        >
                        {isActive ? (
                            <ChevronDown size={14} className="project-chevron" />
                        ) : (
                            <ChevronRight size={14} className="project-chevron" />
                        )}
                        <Folder size={15} />
                        <span className="project-name">{project.name}</span>
                        <small>{project.conversationIds.length}</small>
                        </button>

                        {isActive && (
                        <div className="project-children">
                            {filteredConversations.map((conversation) => (
                            <div
                                className={`conversation-project-item child ${conversation.id === activeId ? 'selected' : ''}`}
                                key={conversation.id}
                            >
                                <button
                                className="conversation-select"
                                title={conversation.title}
                                type="button"
                                onClick={() => onSelectConversation(conversation.id)}
                                >
                                <CornerDownRight size={14} className="conversation-symbol" />
                                {/* <MessageSquare size={14} className="conversation-symbol" /> */}
                                <span className="conversation-title">{conversation.title}</span>
                                </button>
                                <button
                                className="conversation-delete"
                                type="button"
                                aria-label={`Supprimer ${conversation.title}`}
                                onClick={() => onDeleteConversation(conversation.id)}
                                >
                                <X size={14} />
                                </button>
                            </div>
                            ))}

                            {!historyLoading && filteredConversations.length === 0 && (
                            <p className="empty-search child">Aucune conversation dans ce projet.</p>
                            )}
                        </div>
                        )}
                    </div>
                    )
                })}
                </div>

                {projects.length === 0 && projectDraft === null && (
                <div className="projects-empty">
                    <Folder size={22} />
                    <strong>Crée ton premier projet</strong>
                </div>
                )}
            </div>
          ) : sidebarPanel === 'chats' || sidebarPanel === 'pinned' ? (
            <>
              {sidebarPanel === 'chats' && (
                <section className="sidebar-group">
                  <div className="sidebar-section-label">ÉPINGLÉS</div>

                  {pinnedConversations.map((conversation) => (
                    <div
                      className={`conversation-item ${
                        conversation.id === activeId ? 'selected' : ''
                      }`}
                      key={`pin-${conversation.id}`}
                    >
                      <button
                        className="conversation-select"
                        title={conversation.title}
                        onClick={() =>
                          onSelectConversation(conversation.id)
                        }
                      >
                        <Pin
                          size={15}
                          className="conversation-symbol"
                        />
                        <span className="conversation-title">
                          {conversation.title}
                        </span>
                      </button>

                      <button
                        className="conversation-delete"
                        aria-label="Désépingler"
                        title="Désépingler"
                        onClick={() => onTogglePinned(conversation.id)}
                      >
                        <Bookmark size={15} />
                      </button>
                    </div>
                  ))}

                  {!historyLoading && pinnedConversations.length === 0 && (
                    <p className="empty-search">
                      Aucune conversation épinglée.
                    </p>
                  )}
                </section>
              )}

              <div className="sidebar-section-label">
                {sidebarPanel === 'pinned'
                  ? 'TOUTES LES ÉPINGLÉES'
                  : 'HISTORIQUE'}
              </div>

              <div className="conversation-list">
                {historyLoading && (
                  <p className="empty-search">
                    Chargement de l’historique…
                  </p>
                )}

                {!historyLoading &&
                  historyConversations.map((conversation) => {
                    const isPinned = pinnedIds.includes(conversation.id)

                    return (
                      <div
                        className={`conversation-item ${
                          conversation.id === activeId ? 'selected' : ''
                        }`}
                        key={conversation.id}
                      >
                        <button
                          className="conversation-select"
                          title={conversation.title}
                          onClick={() =>
                            onSelectConversation(conversation.id)
                          }
                        >
                          <MessageSquare
                            size={16}
                            className="conversation-symbol"
                          />
                          <span className="conversation-title">
                            {conversation.title}
                          </span>
                        </button>

                        <button
                          className="conversation-delete"
                          title={isPinned ? 'Désépingler' : 'Épingler'}
                          aria-label={
                            isPinned
                              ? 'Désépingler la conversation'
                              : 'Épingler la conversation'
                          }
                          onClick={() => onTogglePinned(conversation.id)}
                        >
                          {isPinned ? (
                            <Bookmark size={15} fill="currentColor" />
                          ) : (
                            <Pin size={15} />
                          )}
                        </button>

                        <button
                          className="conversation-delete"
                          onClick={() =>
                            onDeleteConversation(conversation.id)
                          }
                          aria-label={`Supprimer ${conversation.title}`}
                          title="Supprimer la conversation"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    )
                  })}

                {!historyLoading && historyConversations.length === 0 && (
                  <p className="empty-search">
                    {sidebarPanel === 'pinned'
                      ? 'Aucune conversation épinglée.'
                      : search
                        ? 'Aucune conversation trouvée.'
                        : 'Aucune conversation pour le moment.'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="projects-panel">
              <div className="sidebar-section-label projects-heading">
                <span>AGENTS</span>
                <button
                  className="projects-add-button"
                  type="button"
                  onClick={onCreateAgent}
                  disabled={!onCreateAgent}
                  aria-label="Créer un agent"
                  title={onCreateAgent ? 'Créer un agent' : 'Bientôt disponible'}
                >
                  <Plus size={15} />
                </button>
              </div>

              {agents.length === 0 ? (
                <div className="projects-empty">
                  <Bot size={22} />
                  <strong>Crée ton premier agent</strong>
                </div>
              ) : (
                <div className="agent-list">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className={`agent-item ${agent.id === activeAgentId ? 'active' : ''}`}
                    >
                      <button
                        type="button"
                        className="agent-item-main"
                        title={agent.name}
                        onClick={() => onStartAgent(agent)}
                      >
                        <AgentAvatar avatar={agent.avatar} size={30} />
                        <span className="agent-item-name">{agent.name}</span>
                        <ProviderLogo provider={agent.provider} size={12} />
                      </button>
                      {agent.canEdit && (
                        <button
                          type="button"
                          className="agent-item-edit"
                          aria-label={`Modifier ${agent.name}`}
                          onClick={() => onEditAgent(agent)}
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
              <div className="user-avatar">
                {username.slice(0, 1).toUpperCase() || '?'}
              </div>

              <div className="account-info">
                <strong>{username}</strong>
                <span>Session authentifiée</span>
              </div>

              <button
                className="account-menu"
                onClick={onLogout}
                aria-label="Se déconnecter"
                title="Se déconnecter"
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