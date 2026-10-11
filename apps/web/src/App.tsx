import { useEffect, useRef, useState } from 'react'
import keycloak from './auth/keycloak'
import { api, type Message } from './lib/api'
import './App.css'
import {
  Pencil,
  Code2,
  Lightbulb,
  Image,
  ArrowUp,
  ArrowUpRight,
  Menu,
} from 'lucide-react'
import Sidebar, {
  type SidebarPanel,
} from './components/Sidebar'

type Conversation = {
  id: string
  title: string
  messages: Message[]
  updatedAt: number
}

const suggestions = [
  {
    icon: Lightbulb,
    title: 'Brainstormer',
    text: 'Trouver des idées et explorer des possibilités',
  },
  {
    icon: Code2,
    title: 'Coder',
    text: 'Écrire, comprendre et déboguer du code',
  },
  {
    icon: Pencil,
    title: 'Écrire',
    text: 'Rédiger, reformuler et améliorer un texte',
  },
  {
    icon: Image,
    title: 'Créer',
    text: 'Imaginer un concept ou préparer un visuel',
  },
]

function Snowfall() {
  return (
    <div className="snow-layer" aria-hidden="true">
      {Array.from({ length: 32 }, (_, i) => (
        <span
          key={i}
          className="snowflake"
          style={{
            left: `${(i * 37 + 7) % 100}%`,
            animationDelay: `${(i * 1.73) % 16}s`,
            animationDuration: `${12 + ((i * 7) % 15)}s`,
            opacity: 0.15 + ((i * 3) % 5) * 0.08,
            width: `${2 + (i % 3)}px`,
            height: `${2 + (i % 3)}px`,
          }}
        />
      ))}
    </div>
  )
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [search, setSearch] = useState('')

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeId,
  )

  const username = String(
    keycloak.tokenParsed?.name ??
      keycloak.tokenParsed?.preferred_username ??
      'Utilisateur',
  )

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('chats')
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('snowfall:pinned-conversations')
      return saved ? JSON.parse(saved) as string[] : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem(
      'snowfall:pinned-conversations',
      JSON.stringify(pinnedIds),
    )
  }, [pinnedIds])

  function togglePinned(id: string) {
    setPinnedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [id, ...current],
    )
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [activeConversation?.messages, sending])

  useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  // Charge les conversations enregistrées pour l'utilisateur connecté.
  useEffect(() => {
    let cancelled = false

    async function loadHistory() {
      setHistoryLoading(true)
      setError('')

      try {
        const history = await api.listConversations()
        if (cancelled) return

        const items: Conversation[] = history.map((item) => ({
          id: item.id,
          title: item.title,
          messages: [],
          updatedAt: new Date(item.updatedAt).getTime(),
        }))

        setConversations(items)
        setActiveId((current) =>
          current && items.some((item) => item.id === current)
            ? current
            : items[0]?.id ?? null,
        )
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Impossible de charger les conversations.',
          )
        }
      } finally {
        if (!cancelled) setHistoryLoading(false)
      }
    }

    void loadHistory()

    return () => {
      cancelled = true
    }
  }, [])

  // Charge les messages de la conversation sélectionnée.
  useEffect(() => {
    if (!activeId) {
      setMessagesLoading(false)
      return
    }

    let cancelled = false
    setMessagesLoading(true)

    async function loadMessages() {
      try {
        const messages = await api.getMessages(activeId!)
        if (cancelled) return

        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === activeId
              ? { ...conversation, messages }
              : conversation,
          ),
        )
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Impossible de charger les messages.',
          )
        }
      } finally {
        if (!cancelled) setMessagesLoading(false)
      }
    }

    void loadMessages()

    return () => {
      cancelled = true
    }
  }, [activeId])

  function updateConversation(
    id: string,
    updater: (conversation: Conversation) => Conversation,
  ) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id ? updater(conversation) : conversation,
      ),
    )
  }

  async function newChat() {
    if (creating) return

    abortRef.current?.abort()
    setError('')
    setInput('')
    setSidebarOpen(false)
    setCreating(true)

    try {
      const created = await api.createConversation()

      const conversation: Conversation = {
        id: created.id,
        title: created.title,
        messages: [],
        updatedAt: new Date(created.updatedAt).getTime(),
      }

      setConversations((current) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id),
      ])
      setActiveId(conversation.id)

      requestAnimationFrame(() => inputRef.current?.focus())
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Impossible de créer la conversation.',
      )
    } finally {
      setCreating(false)
    }
  }

  async function sendMessage(text = input) {
    const message = text.trim()
    const conversation = conversations.find((item) => item.id === activeId)

    if (!message || sending || !conversation || messagesLoading) return

    if (!keycloak.authenticated || !keycloak.token) {
      setError('Ta session a expiré. Reconnecte-toi pour continuer.')
      return
    }

    const conversationId = conversation.id
    const previousMessages = conversation.messages

    setInput('')
    setError('')
    setSending(true)

    const controller = new AbortController()
    abortRef.current = controller

    // Affichage optimiste : le message apparaît immédiatement.
    const optimisticMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    }

    updateConversation(conversationId, (current) => ({
      ...current,
      title:
        current.messages.length === 0
          ? message.slice(0, 80)
          : current.title,
      messages: [...current.messages, optimisticMessage],
      updatedAt: Date.now(),
    }))

    try {
      // Cette route enregistre le message utilisateur et la réponse.
      const result = await api.sendMessage(conversationId, message)

      if (controller.signal.aborted) return

      updateConversation(conversationId, (current) => ({
        ...current,
        title:
          previousMessages.length === 0
            ? result.userMessage.content.slice(0, 80)
            : current.title,
        messages: [
          ...current.messages.filter(
            (item) => item.id !== optimisticMessage.id,
          ),
          result.userMessage,
          result.assistantMessage,
        ],
        updatedAt: Date.now(),
      }))

      // Synchronise l'ordre et les titres depuis le serveur.
      const history = await api.listConversations()
      if (controller.signal.aborted) return

      setConversations((current) =>
        current
          .map((item) => {
            const saved = history.find((entry) => entry.id === item.id)
            return saved
              ? {
                  ...item,
                  title: saved.title,
                  updatedAt: new Date(saved.updatedAt).getTime(),
                }
              : item
          })
          .sort((a, b) => b.updatedAt - a.updatedAt),
      )
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return

      // Retire le message optimiste si l'envoi a échoué.
      updateConversation(conversationId, (current) => ({
        ...current,
        messages: current.messages.filter(
          (item) => item.id !== optimisticMessage.id,
        ),
      }))

      setError(
        cause instanceof Error
          ? cause.message
          : 'Impossible de contacter Snowfall.',
      )
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setSending(false)
      }
    }
  }

  async function deleteConversation(id: string) {
    if (sending) return

    const confirmed = window.confirm(
      'Supprimer cette conversation et tous ses messages ?',
    )
    if (!confirmed) return

    setError('')

    try {
      await api.deleteConversation(id)

      const remaining = conversations.filter((item) => item.id !== id)
      setConversations(remaining)

      if (activeId === id) {
        setActiveId(remaining[0]?.id ?? null)
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Impossible de supprimer cette conversation.',
      )
    }
  }

  function logout() {
    void keycloak.logout({ redirectUri: window.location.origin })
  }

  function handleComposerKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  return (
    <main className="snowfall-app">
      <Snowfall />

      <Sidebar
        conversations={conversations}
        activeId={activeId}
        username={username}
        historyLoading={historyLoading}
        creating={creating}
        sidebarOpen={sidebarOpen}
        sidebarCollapsed={sidebarCollapsed}
        sidebarPanel={sidebarPanel}
        search={search}
        pinnedIds={pinnedIds}
        onNewChat={() => void newChat()}
        onSelectConversation={(id) => {
          setActiveId(id)
          setSidebarOpen(false)
          setError('')
        }}
        onDeleteConversation={(id) => void deleteConversation(id)}
        onTogglePinned={togglePinned}
        onLogout={logout}
        onSearchChange={setSearch}
        onSidebarOpenChange={setSidebarOpen}
        onSidebarCollapsedChange={setSidebarCollapsed}
        onSidebarPanelChange={setSidebarPanel}
        onSettings={() =>
          setError('Les paramètres dédiés seront ajoutés dans une prochaine étape.')
        }
      />

      <section className="chat-workspace">
        <header className="chat-topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu-button"
              aria-label="Ouvrir le menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </button>
            <span className="workspace-label">VOTRE ESPACE</span>
            <span className="topbar-divider">/</span>
            <span className="topbar-current">
              {activeConversation?.title ?? 'Nouvelle conversation'}
            </span>
          </div>

          <div className="topbar-right">
            <span className="secure-indicator">
              <span className="secure-dot" />
              Connecté
            </span>
            <button
              className="icon-button"
              onClick={() => void newChat()}
              disabled={creating}
              aria-label="Nouvelle conversation"
              title="Nouvelle conversation"
            >
              ＋
            </button>
          </div>
        </header>

        <div className="chat-scroll-area">
          {historyLoading || messagesLoading ? (
            <div className="welcome">
              <div className="typing-indicator" aria-label="Chargement">
                <span />
                <span />
                <span />
              </div>
              <p className="welcome-description">
                Chargement de votre conversation…
              </p>
            </div>
          ) : !activeConversation || activeConversation.messages.length === 0 ? (
            <section className="welcome">
              <div className="welcome-orbit">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="orbit-core">
                  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
                    <path
                      d="M24 5v38M7.55 14.5l32.9 19M7.55 33.5l32.9-19M17 9l7 4 7-4M17 39l7-4 7 4M8 24l5-8M40 24l-5-8M8 24l5 8M40 24l-5 8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                    <circle cx="24" cy="24" r="4" fill="currentColor" />
                  </svg>
                </div>
                <span className="orbit-star star-a">✳</span>
                <span className="orbit-star star-b">✧</span>
                <span className="orbit-star star-c">·</span>
              </div>

              <div className="welcome-eyebrow">
                <span /> UN ESPACE POUR VOS IDÉES
              </div>
              <h1>
                Laissez vos idées
                <br />
                <span>prendre forme.</span>
              </h1>
              <p className="welcome-description">
                Réfléchissez, explorez, créez. Un espace calme pour aller plus
                loin, une conversation à la fois.
              </p>

              <div className="suggestion-grid">
                {suggestions.map((suggestion) => (
                  <button
                    className="suggestion-card"
                    key={suggestion.title}
                    onClick={() => {
                      setInput(suggestion.text)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="suggestion-icon">
                      <suggestion.icon size={19} strokeWidth={1.7} />
                    </span>
                    <span className="suggestion-copy">
                      <strong>{suggestion.title}</strong>
                      <span>{suggestion.text}</span>
                    </span>
                    <span className="suggestion-arrow"><ArrowUpRight size={15} /></span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <section className="messages" aria-live="polite">
              {activeConversation.messages.map((message) => (
                <article
                  className={`message message-${message.role}`}
                  key={message.id}
                >
                  <div className="message-avatar">
                    {message.role === 'user' ? (
                      username.slice(0, 1).toUpperCase()
                    ) : (
                      <span>✳</span>
                    )}
                  </div>
                  <div className="message-body">
                    <div className="message-author">
                      {message.role === 'user' ? username : 'Snowfall'}
                    </div>
                    <p>{message.content}</p>
                    {message.role === 'assistant' && (
                      <button
                        className="copy-message"
                        onClick={() =>
                          void navigator.clipboard?.writeText(message.content)
                        }
                      >
                        ⧉ Copier
                      </button>
                    )}
                  </div>
                </article>
              ))}

              {sending && (
                <div className="message message-assistant">
                  <div className="message-avatar">✳</div>
                  <div className="message-body">
                    <div className="message-author">Snowfall</div>
                    <div
                      className="typing-indicator"
                      aria-label="Réponse en cours"
                    >
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </section>
          )}
        </div>

        <footer className="composer-area">
          {error && (
            <div className="error-notice" role="alert">
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Fermer">
                ×
              </button>
            </div>
          )}

          <div className="composer">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Posez votre question, explorez une idée..."
              rows={1}
              aria-label="Votre message"
              disabled={sending || !activeConversation || messagesLoading}
            />
            <div className="composer-toolbar">
              <div className="composer-hints">
                <span className="composer-sparkle">✧</span>
                <span>Un espace pour penser librement</span>
              </div>
              <div className="composer-actions">
                <span className="keyboard-hint">↵ Envoyer</span>
                <button
                  className="send-button"
                  onClick={() => void sendMessage()}
                  disabled={!input.trim() || sending || !activeConversation || messagesLoading}
                  aria-label="Envoyer le message"
                  title="Envoyer"
                >
                  <ArrowUp size={18} />
                </button>
              </div>
            </div>
          </div>
          <p className="composer-disclaimer">
            Snowfall peut se tromper. Vérifiez les informations importantes.
          </p>
        </footer>
      </section>
    </main>
  )
}

export default App