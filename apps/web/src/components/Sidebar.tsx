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
} from 'lucide-react'

export type SidebarPanel = 'chats' | 'pinned' | 'projects' | 'agents'

export type SidebarConversation = {
  id: string
  title: string
}

type SidebarProps = {
  conversations: SidebarConversation[]
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
  onSettings: () => void
}

export default function Sidebar({
  conversations,
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
  onSettings,
}: SidebarProps) {
  const filteredConversations = conversations.filter((conversation) =>
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
              <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
                <path
                  d="M16 3v26M4.75 9.5l22.5 13M4.75 22.5l22.5-13M11 5.8l5 3 5-3M11 26.2l5-3 5 3"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </span>
          </button>

          <div className="rail-divider" />

          {(
            [
              { id: 'chats', label: 'Conversations', icon: MessageSquare },
              { id: 'pinned', label: 'Épinglés', icon: Bookmark },
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
                snowfall<span>.</span>
              </span>
            </a>
          </header>

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

          {sidebarPanel === 'chats' || sidebarPanel === 'pinned' ? (
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
            <div className="sidebar-placeholder">
              <div className="sidebar-placeholder-icon">
                {sidebarPanel === 'projects' ? (
                  <Folder size={22} />
                ) : (
                  <Bot size={22} />
                )}
              </div>

              <strong>
                {sidebarPanel === 'projects' ? 'Projets' : 'Agents'}
              </strong>

              <p>
                {sidebarPanel === 'projects'
                  ? 'L’organisation des conversations par projet sera ajoutée ici.'
                  : 'Les agents personnalisés seront ajoutés ici.'}
              </p>
            </div>
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