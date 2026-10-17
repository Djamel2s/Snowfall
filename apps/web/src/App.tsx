import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { getSession, logout as endSession } from './auth/session'
import {
  api,
  type Agent,
  type AttachmentMeta,
  type AgentStep,
  type RunSnapshot,
  type GeneratedFile,
  approvalStep,
  isPaused,
  type KnowledgeOwnerKind,
  type Message,
  type ModelSelection,
  type Preferences,
  type ProviderCatalog,
  type Project,
  type SearchHit,
} from './lib/api'
import { setLocale, useI18n } from './lib/i18n'
import { toAttachmentImage } from './lib/image'
import './App.css'
import './agents.css'
import './workspace.css'
import { ArrowUp, BookOpen, Check, Copy, Menu, Paperclip, Pencil, RefreshCw, Square, X } from 'lucide-react'
import Sidebar, { type SidebarPanel } from './components/Sidebar'
import LanguageSwitcher from './components/LanguageSwitcher'
import { AgentAvatar, MessageAgentAvatar, ProviderLogo } from './components/AgentAvatar'
import AttachmentChip from './components/AttachmentChip'
import Markdown from './components/Markdown'
import MessageSources from './components/MessageSources'
import AgentSteps from './components/AgentSteps'
import Reasoning from './components/Reasoning'
import MessageFiles from './components/MessageFiles'
import ArtifactPanel from './components/ArtifactPanel'
import { ArtifactContext, artifactsIn, wantsCode, type Artifact } from './lib/artifacts'
import ResponderPicker, { type PickerControl } from './components/ResponderPicker'
import {
  mentionAt,
  readLastChoice,
  resolveResponder,
  saveLastChoice,
  usableProviders,
  type ResponderChoice,
} from './lib/responder'

type Conversation = {
  id: string
  title: string
  agentId: string | null
  model: ModelSelection | null
  /** Bases de connaissances consultées (agent, projet). */
  knowledge: { agent: boolean; project: boolean }
  projectId: string | null
  messages: Message[]
  updatedAt: number
}

type PendingFile = {
  localId: string
  conversationId: string
  name: string
  size: number
  kind: 'document' | 'image'
  status: 'uploading' | 'ready' | 'error'
  preview?: string
  attachment?: AttachmentMeta
}

const defaultPreferences: Preferences = { locale: null, sendOnEnter: true, reduceMotion: 'system' }
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const ACCEPT = '.pdf,.docx,.txt,.md,.csv,.json,image/png,image/jpeg,image/webp'
const DOCUMENT_MAX = 10 * 1024 * 1024
const LEGACY_PROJECTS_KEY = 'snowfall:projects'

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

const toConversation = (item: {
  id: string
  title: string
  agentId: string | null
  model?: ModelSelection | null
  knowledge?: { agent: boolean; project: boolean }
  projectId: string | null
  updatedAt: string
}): Conversation => ({
  id: item.id,
  title: item.title,
  agentId: item.agentId,
  model: item.model ?? null,
  knowledge: item.knowledge ?? { agent: true, project: true },
  projectId: item.projectId,
  messages: [],
  updatedAt: new Date(item.updatedAt).getTime(),
})

function App() {
  const { t } = useI18n()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  // Étapes de l'agent pendant la réponse (outils appelés), remplacées à chaque nouvel état.
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([])
  const onStep = (step: AgentStep) =>
    setAgentSteps((current) => (current.some((item) => item.id === step.id) ? current.map((item) => (item.id === step.id ? { ...item, ...step } : item)) : [...current, step]))
  // Conversation dont la réponse s'écrit (ou attend une validation).
  const streamingIdRef = useRef<string | null>(null)
  // Réponse en pause : elle attend ta décision sur une action (exécution durable).
  const [paused, setPaused] = useState(false)
  // Réflexion du modèle : en direct, puis rattachée à la réponse (cette session
  // seulement : elle n'est jamais enregistrée).
  // Artifact affiché à côté de la conversation (page HTML, SVG, diagramme).
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const closeArtifact = useCallback(() => setArtifact(null), [])
  // Copie des conversations lisible à la fin d'une réponse (ouverture de son artifact).
  const conversationsRef = useRef({ conversations, activeId })
  useEffect(() => {
    conversationsRef.current = { conversations, activeId }
  }, [conversations, activeId])
  const [reasoning, setReasoning] = useState('')
  const reasoningRef = useRef('')
  const [reasoningByMessage, setReasoningByMessage] = useState<Record<string, string>>({})
  // Fichiers produits par l'interpréteur de code, par conversation.
  const [generatedFiles, setGeneratedFiles] = useState<Record<string, GeneratedFile[]>>({})
  const refreshFiles = (conversationId: string) =>
    api
      .listGeneratedFiles(conversationId)
      .then((files) => setGeneratedFiles((current) => ({ ...current, [conversationId]: files })))
      .catch(() => undefined)
  const onReasoning = (text: string) => {
    reasoningRef.current += text
    setReasoning(reasoningRef.current)
  }
  const showReasoning = (text: string) => {
    reasoningRef.current = text
    setReasoning(text)
  }
  // Régénération : la dernière réponse est masquée pendant qu'une nouvelle s'écrit.
  const [regenerating, setRegenerating] = useState(false)
  // L'avatar réfléchit en attendant le premier mot, puis « parle » pendant la réponse.
  const agentMood = sending ? (streamingText ? 'talking' : 'thinking') : 'idle'
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<SearchHit[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  // undefined = studio fermé, null = création, Agent = édition.
  const [studioAgent, setStudioAgent] = useState<Agent | null | undefined>(undefined)
  const [studioNotice, setStudioNotice] = useState<string | undefined>(undefined)
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences)
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [catalog, setCatalog] = useState<{ providers: ProviderCatalog[]; defaultModel: ModelSelection | null }>({
    providers: [],
    defaultModel: null,
  })
  const [pickerOpen, setPickerOpen] = useState(false)
  // Mention « @… » en cours dans le message : position du « @ » et texte tapé.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const pickerRef = useRef<PickerControl>(null)
  // Sources prêtes par base (« agents:<id> », « projects:<id> ») : affiche les bascules.
  const [knowledgeCounts, setKnowledgeCounts] = useState<Record<string, number>>({})

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const stoppedRef = useRef(false)

  const messagesLoading = activeId !== null && loadedId !== activeId
  const activeConversation = conversations.find((conversation) => conversation.id === activeId)
  const responder = resolveResponder(activeConversation, agents, catalog.providers, catalog.defaultModel)
  const activeAgent = responder.kind === 'agent' ? responder.agent : null
  const agentKnowledge = activeAgent ? (knowledgeCounts[`agents:${activeAgent.id}`] ?? 0) : 0
  const projectKnowledge = activeConversation?.projectId ? (knowledgeCounts[`projects:${activeConversation.projectId}`] ?? 0) : 0

  const conversationIsEmpty = !activeConversation || activeConversation.messages.length === 0
  // Pièces jointes en attente de la conversation affichée uniquement.
  const activeFiles = pendingFiles.filter((file) => file.conversationId === activeId)
  const shownResults = search.trim().length >= 2 ? searchResults : []

  const session = getSession()
  const { profile } = session
  const username = profile.name ?? profile.username ?? 'Utilisateur'
  const canWrite = session.user.role !== 'reader'

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarPanel, setSidebarPanel] = useState<SidebarPanel>('chats')
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('snowfall:pinned-conversations')
      return saved ? (JSON.parse(saved) as string[]) : []
    } catch {
      return []
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('snowfall:pinned-conversations', JSON.stringify(pinnedIds))
    } catch {
      // Épingles non conservées : sans gravité.
    }
  }, [pinnedIds])

  // Animations réduites à la demande, en plus de la préférence système.
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', preferences.reduceMotion === 'on')
  }, [preferences.reduceMotion])

  function togglePinned(id: string) {
    setPinnedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [id, ...current]))
  }

  function fail(cause: unknown, fallback: Parameters<typeof t>[0]) {
    setError(cause instanceof Error ? cause.message : t(fallback))
  }

  useEffect(() => {
    // Pendant le streaming, défilement instantané : un défilement animé à
    // chaque fragment saccaderait.
    bottomRef.current?.scrollIntoView({ behavior: streamingText ? 'auto' : 'smooth', block: 'end' })
  }, [activeConversation?.messages, sending, streamingText])

  useEffect(() => () => abortRef.current?.abort(), [])

  // Chargement initial : conversations, agents, projets, préférences.
  useEffect(() => {
    let cancelled = false

    async function load() {
      setHistoryLoading(true)
      setError('')
      try {
        await migrateLegacyProjects()
        const [history, projectList] = await Promise.all([api.listConversations(), api.listProjects()])
        if (cancelled) return
        const items = history.map(toConversation)

        setConversations(items)
        setProjects(projectList)
        setActiveId((current) =>
          current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null,
        )
      } catch (cause) {
        if (!cancelled) fail(cause, 'error.loadConversations')
      } finally {
        if (!cancelled) setHistoryLoading(false)
      }
    }

    void load()
    api.listAgents().then((items) => !cancelled && setAgents(items)).catch(() => undefined)
    api.modelCatalog().then((items) => !cancelled && setCatalog(items)).catch(() => undefined)
    api
      .getPreferences()
      .then((saved) => {
        if (cancelled) return
        setPreferences(saved)
        if (saved.locale) setLocale(saved.locale)
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeId) return

    const id = activeId
    let cancelled = false

    async function loadMessages() {
      try {
        const messages = await api.getMessages(id)
        if (cancelled) return
        updateConversation(id, (conversation) => ({ ...conversation, messages }))
        void refreshFiles(id)
        // Réponse encore en cours ou en attente de validation : on la retrouve.
        void resumeRun(id)
      } catch (cause) {
        if (!cancelled) fail(cause, 'error.loadMessages')
      } finally {
        if (!cancelled) setLoadedId(id)
      }
    }

    void loadMessages()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // Bases de connaissances de la conversation affichée (agent et projet).
  const activeAgentId = activeAgent?.id ?? null
  const activeProject = activeConversation?.projectId ?? null
  useEffect(() => {
    let cancelled = false
    const owners: [KnowledgeOwnerKind, string][] = []
    if (activeAgentId) owners.push(['agents', activeAgentId])
    if (activeProject) owners.push(['projects', activeProject])
    for (const [kind, id] of owners) {
      api
        .getKnowledge(kind, id)
        .then((view) => {
          if (cancelled) return
          const ready = view.sources.filter((source) => source.status === 'ready').length
          setKnowledgeCounts((current) => ({ ...current, [`${kind}:${id}`]: ready }))
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
    // Rechargé aussi à la fermeture du studio (documents ajoutés à l'agent).
  }, [activeAgentId, activeProject, studioAgent, sidebarPanel])

  async function toggleKnowledge(key: 'agent' | 'project') {
    const conversation = activeConversation
    if (!conversation) return
    const next = { ...conversation.knowledge, [key]: !conversation.knowledge[key] }
    updateConversation(conversation.id, (current) => ({ ...current, knowledge: next }))
    try {
      await api.updateConversation(conversation.id, { knowledge: { [key]: next[key] } })
    } catch (cause) {
      updateConversation(conversation.id, (current) => ({ ...current, knowledge: conversation.knowledge }))
      fail(cause, 'error.send')
    }
  }

  // Recherche dans le contenu des messages (côté serveur, chiffré au repos).
  useEffect(() => {
    const query = search.trim()
    if (query.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      api
        .searchConversations(query, controller.signal)
        .then(setSearchResults)
        .catch(() => undefined)
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [search])

  function updateConversation(id: string, updater: (conversation: Conversation) => Conversation) {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === id ? updater(conversation) : conversation)),
    )
  }

  function savePreferences(next: Preferences) {
    setPreferences(next)
    api.savePreferences(next).catch((cause) => fail(cause, 'error.send'))
  }

  async function newChat(agent?: Agent) {
    if (creating) return

    abortRef.current?.abort()
    setError('')
    setInput('')
    setSidebarOpen(false)
    setCreating(true)

    // Sans agent demandé : on reprend le dernier choix (agent ou modèle) s'il est toujours proposé.
    const last = agent ? null : readLastChoice()
    const remembered =
      last?.kind === 'agent' && agents.some((item) => item.id === last.agentId)
        ? { agentId: last.agentId }
        : last?.kind === 'model' &&
            usableProviders(catalog.providers).some(
              (provider) => provider.id === last.selection.provider && provider.models.some((model) => model.id === last.selection.model),
            )
          ? { model: last.selection }
          : {}
    const base = activeProjectId ? { projectId: activeProjectId } : {}

    try {
      const created = await api
        .createConversation({ ...base, ...(agent ? { agentId: agent.id } : remembered) })
        // Choix mémorisé refusé entre-temps (modèle retiré, fournisseur interdit) : modèle par défaut.
        .catch((cause: unknown) => {
          if (agent || Object.keys(remembered).length === 0) throw cause
          return api.createConversation(base)
        })
      const conversation = toConversation(created)
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
      setActiveId(conversation.id)
      requestAnimationFrame(() => inputRef.current?.focus())
    } catch (cause) {
      fail(cause, 'error.createConversation')
    } finally {
      setCreating(false)
    }
  }

  /** Change d'agent ou de modèle tant que la conversation n'a pas commencé. */
  async function selectResponder(choice: ResponderChoice) {
    const conversation = activeConversation
    if (!conversation || conversation.messages.length > 0 || !canWrite) return

    const next =
      choice.kind === 'agent'
        ? { agentId: choice.agentId, model: null }
        : { agentId: null, model: choice.selection }
    const previous = { agentId: conversation.agentId, model: conversation.model }
    saveLastChoice(choice)
    updateConversation(conversation.id, (current) => ({ ...current, ...next }))
    requestAnimationFrame(() => inputRef.current?.focus())

    try {
      await api.updateConversation(conversation.id, next)
    } catch (cause) {
      updateConversation(conversation.id, (current) => ({ ...current, ...previous }))
      fail(cause, 'error.send')
    }
  }

  function closePicker() {
    setPickerOpen(false)
    setMention(null)
  }

  function pickResponder(choice: ResponderChoice) {
    // Mention « @… » : le texte tapé pour chercher disparaît du message.
    if (mention) {
      setInput((current) => current.slice(0, mention.start) + current.slice(mention.start + 1 + mention.query.length))
    }
    closePicker()
    void selectResponder(choice)
  }

  function onComposerChange(value: string, caret: number) {
    setInput(value)
    const found = conversationIsEmpty && canWrite ? mentionAt(value, caret) : null
    if (found) {
      setMention(found)
      setPickerOpen(true)
    } else if (mention) {
      closePicker()
    }
  }

  async function createProject(name: string) {
    try {
      const project = await api.createProject(name)
      setProjects((current) => [project, ...current])
      setActiveProjectId(project.id)
    } catch (cause) {
      fail(cause, 'error.send')
    }
  }

  async function renameProject(id: string, name: string) {
    try {
      const project = await api.renameProject(id, name)
      setProjects((current) => current.map((item) => (item.id === id ? project : item)))
    } catch (cause) {
      fail(cause, 'error.send')
    }
  }

  async function deleteProject(id: string) {
    try {
      await api.deleteProject(id)
      setProjects((current) => current.filter((item) => item.id !== id))
      setConversations((current) => current.map((item) => (item.projectId === id ? { ...item, projectId: null } : item)))
      if (activeProjectId === id) setActiveProjectId(null)
    } catch (cause) {
      fail(cause, 'error.send')
    }
  }

  async function renameConversation(id: string, title: string) {
    try {
      const saved = await api.updateConversation(id, { title })
      updateConversation(id, (conversation) => ({ ...conversation, title: saved.title }))
    } catch (cause) {
      fail(cause, 'error.send')
    }
  }

  async function moveConversation(id: string, projectId: string | null) {
    try {
      await api.updateConversation(id, { projectId })
      updateConversation(id, (conversation) => ({ ...conversation, projectId }))
    } catch (cause) {
      fail(cause, 'error.send')
    }
  }

  function openAgentEditor(agent: Agent | null) {
    setSidebarPanel('agents')
    setSidebarCollapsed(false)
    setSidebarOpen(true)
    setStudioNotice(undefined)
    setStudioAgent(agent)
  }

  const visibleConversations = activeProjectId
    ? conversations.filter((conversation) => conversation.projectId === activeProjectId)
    : conversations

  // ---- Pièces jointes -----------------------------------------------------

  async function addFiles(files: File[]) {
    const conversation = activeConversation
    if (!conversation || !canWrite) return

    for (const file of files) {
      const localId = crypto.randomUUID()
      const isImage = IMAGE_TYPES.includes(file.type)
      if (!isImage && file.size > DOCUMENT_MAX) {
        setError(t('error.fileTooLarge'))
        continue
      }
      const preview = isImage ? URL.createObjectURL(file) : undefined
      setPendingFiles((current) => [
        ...current,
        { localId, conversationId: conversation.id, name: file.name, size: file.size, kind: isImage ? 'image' : 'document', status: 'uploading', ...(preview ? { preview } : {}) },
      ])

      try {
        // Images réencodées dans le navigateur : EXIF et GPS ne partent jamais.
        const body = isImage ? await toAttachmentImage(file) : file
        const attachment = await api.uploadAttachment(conversation.id, body, file.name)
        setPendingFiles((current) =>
          current.map((item) => (item.localId === localId ? { ...item, status: 'ready', attachment, size: attachment.size } : item)),
        )
      } catch (cause) {
        setPendingFiles((current) => current.map((item) => (item.localId === localId ? { ...item, status: 'error' } : item)))
        setError(
          cause instanceof Error && cause.message === 'IMAGE_TOO_LARGE'
            ? t('error.fileTooLarge')
            : cause instanceof Error
              ? cause.message
              : t('error.send'),
        )
      }
    }
  }

  function removePendingFile(file: PendingFile) {
    setPendingFiles((current) => current.filter((item) => item.localId !== file.localId))
    if (file.preview) URL.revokeObjectURL(file.preview)
    if (file.attachment) void api.deleteAttachment(file.attachment.id).catch(() => undefined)
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    if (event.dataTransfer.files.length) void addFiles([...event.dataTransfer.files])
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files]
    if (files.length) {
      event.preventDefault()
      void addFiles(files)
    }
  }

  // ---- Génération (envoi, modification, régénération, arrêt) ---------------

  /** Fin de réponse : l'interface revient au repos. */
  function resetStreaming() {
    setSending(false)
    setStreamingText('')
    setAgentSteps([])
    setRegenerating(false)
    setPaused(false)
    showReasoning('')
    streamingIdRef.current = null
  }

  /** Messages relus depuis le serveur (réponse terminée ailleurs, après une pause…). */
  async function refreshMessages(conversationId: string) {
    const messages = await api.getMessages(conversationId)
    updateConversation(conversationId, (conversation) => ({ ...conversation, messages }))
    return messages.at(-1)?.role === 'assistant' ? messages.at(-1)!.id : undefined
  }

  /**
   * Suit une réponse : envoi, reprise après une validation (resume : texte et
   * étapes conservés), ou reconnexion. run renvoie « paused » si la réponse
   * attend une décision : l'interface reste alors sur la réponse en cours.
   */
  async function stream(
    conversationId: string,
    run: (signal: AbortSignal, onToken: (text: string) => void) => Promise<'paused' | string | void>,
    rollback: () => void,
    options: { resume?: boolean } = {},
  ) {
    setError('')
    setSending(true)
    setPaused(false)
    if (!options.resume) {
      setAgentSteps([])
      showReasoning('')
    }
    streamingIdRef.current = conversationId
    stoppedRef.current = false
    const controller = new AbortController()
    abortRef.current = controller
    let keep = false

    try {
      const outcome = await run(controller.signal, (text) => {
        if (!controller.signal.aborted) setStreamingText((current) => current + text)
      })
      if (outcome === 'paused') {
        keep = true
        setPaused(true)
        return
      }
      // Réponse terminée (outcome : son identifiant) : la réflexion reste consultable.
      const thought = reasoningRef.current
      if (outcome && thought) setReasoningByMessage((current) => ({ ...current, [outcome]: thought }))
      // Fichiers produits par le code pendant cette réponse.
      void refreshFiles(conversationId)
      // Synchronise l'ordre et les titres depuis le serveur.
      const history = await api.listConversations()
      setConversations((current) =>
        current
          .map((item) => {
            const saved = history.find((entry) => entry.id === item.id)
            return saved ? { ...item, title: saved.title, updatedAt: new Date(saved.updatedAt).getTime() } : item
          })
          .sort((a, b) => b.updatedAt - a.updatedAt),
      )
      // Un seul artifact dans la réponse (et toujours sur cette conversation) : ouvert d'office.
      const answer = outcome ? conversationsRef.current.conversations.find((item) => item.id === conversationId)?.messages.find((item) => item.id === outcome) : undefined
      const found = answer ? artifactsIn(answer.content) : []
      if (found.length === 1 && conversationsRef.current.activeId === conversationId) setArtifact(found[0]!)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        // Arrêt volontaire : la réponse partielle est enregistrée côté serveur.
        if (stoppedRef.current) {
          setTimeout(() => {
            api
              .getMessages(conversationId)
              .then((messages) => updateConversation(conversationId, (conversation) => ({ ...conversation, messages })))
              .catch(() => undefined)
          }, 600)
        }
        return
      }
      rollback()
      fail(cause, 'error.send')
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        if (!keep) resetStreaming()
      }
    }
  }

  /**
   * Arrêter : demandé au serveur (fermer l'onglet ne suffit plus, la réponse
   * continuerait). La réponse partielle est gardée.
   */
  function stopGeneration() {
    stoppedRef.current = true
    const conversationId = streamingIdRef.current
    if (conversationId) api.cancelRun(conversationId).catch(() => undefined)
    abortRef.current?.abort()
    if (paused && conversationId) {
      resetStreaming()
      setTimeout(() => void refreshMessages(conversationId).catch(() => undefined), 600)
    }
  }

  /** Ta décision : la réponse reprend dans la même bulle (texte et étapes gardés). */
  async function decideApproval(approvalId: string, approved: boolean) {
    const conversationId = streamingIdRef.current
    if (!conversationId) throw new Error(t('agent.approvalExpired'))
    setAgentSteps((current) => current.map((step) => (step.approval?.id === approvalId ? { ...step, approval: undefined } : step)))
    await stream(
      conversationId,
      async (signal, onToken) => {
        const result = await api.decideApproval(conversationId, approvalId, approved, { signal, onToken, onReasoning, onStep })
        if (isPaused(result)) return 'paused'
        return refreshMessages(conversationId)
      },
      () => void refreshMessages(conversationId).catch(() => undefined),
      { resume: true },
    )
  }

  /** Étapes et validations en attente d'une réponse reprise (reconnexion). */
  const restoreSteps = (snapshot: RunSnapshot) =>
    snapshot.approvals.reduce<AgentStep[]>(
      (steps, approval) => {
        const pending = approvalStep(approval)
        return steps.some((step) => step.id === pending.id)
          ? steps.map((step) => (step.id === pending.id ? { ...step, approval: pending.approval, status: 'running' } : step))
          : [...steps, pending]
      },
      snapshot.steps.map((step) => ({ ...step })),
    )

  /**
   * Conversation ouverte avec une réponse en cours (onglet rouvert, autre
   * appareil) : la question, le texte et les étapes réapparaissent, puis la
   * suite arrive en direct ; une validation en attente est proposée à nouveau.
   */
  async function resumeRun(conversationId: string) {
    if (streamingIdRef.current) return
    const run = await api.getRun(conversationId).catch(() => null)
    if (!run || streamingIdRef.current) return
    if (run.kind === 'message') {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        messages: [...conversation.messages, { id: `run-${run.id}`, role: 'user', content: run.question, createdAt: new Date().toISOString() }],
      }))
    } else {
      setRegenerating(true)
    }
    setStreamingText(run.text)
    showReasoning(run.reasoning ?? '')
    setAgentSteps(restoreSteps(run))
    if (run.status === 'waiting') {
      streamingIdRef.current = conversationId
      setSending(true)
      setPaused(true)
      return
    }
    await stream(
      conversationId,
      async (signal, onToken) => {
        const result = await api.watchRun(conversationId, {
          signal,
          onToken,
          onReasoning,
          onStep,
          onSnapshot: (snapshot) => {
            setStreamingText(snapshot.text)
            showReasoning(snapshot.reasoning ?? '')
            setAgentSteps(restoreSteps(snapshot))
          },
        })
        if (isPaused(result)) return 'paused'
        return refreshMessages(conversationId)
      },
      () => void refreshMessages(conversationId).catch(() => undefined),
      { resume: true },
    )
  }

  async function sendMessage() {
    const message = input.trim()
    const conversation = activeConversation
    const ready = activeFiles.filter((file) => file.status === 'ready' && file.attachment)
    const uploading = activeFiles.some((file) => file.status === 'uploading')

    if ((!message && ready.length === 0) || uploading || sending || !conversation || messagesLoading) return

    const conversationId = conversation.id
    const attachments = ready.map((file) => file.attachment!)
    const optimistic: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
      attachments,
    }

    setInput('')
    setPendingFiles((current) => current.filter((file) => file.conversationId !== conversationId))
    updateConversation(conversationId, (current) => ({
      ...current,
      title: current.messages.length === 0 ? (message || attachments[0]?.name || current.title).slice(0, 80) : current.title,
      messages: [...current.messages, optimistic],
      updatedAt: Date.now(),
    }))

    await stream(
      conversationId,
      async (signal, onToken) => {
        const result = await api.sendMessage(
          conversationId,
          { content: message, attachmentIds: attachments.map((file) => file.id) },
          { signal, onToken, onReasoning, onStep },
        )
        if (isPaused(result)) return 'paused'
        updateConversation(conversationId, (current) => ({
          ...current,
          messages: [...current.messages.filter((item) => item.id !== optimistic.id), result.userMessage, result.assistantMessage],
        }))
        return result.assistantMessage.id
      },
      () => {
        updateConversation(conversationId, (current) => ({
          ...current,
          messages: current.messages.filter((item) => item.id !== optimistic.id),
        }))
        setInput(message)
        setPendingFiles((current) => [...current, ...ready])
      },
    )
  }

  async function submitEdit() {
    const conversation = activeConversation
    if (!editing || !conversation || sending) return
    const text = editing.text.trim()
    const index = conversation.messages.findIndex((item) => item.id === editing.id)
    const original = conversation.messages[index]
    if (!original || (!text && !original.attachments?.length)) return

    const previous = conversation.messages
    const attachmentIds = original.attachments?.map((file) => file.id) ?? []
    const optimistic: Message = { ...original, id: crypto.randomUUID(), content: text }
    setEditing(null)
    updateConversation(conversation.id, (current) => ({ ...current, messages: [...previous.slice(0, index), optimistic] }))

    await stream(
      conversation.id,
      async (signal, onToken) => {
        const result = await api.sendMessage(
          conversation.id,
          { content: text, attachmentIds, editMessageId: original.id },
          { signal, onToken, onReasoning, onStep },
        )
        if (isPaused(result)) return 'paused'
        updateConversation(conversation.id, (current) => ({
          ...current,
          messages: [...previous.slice(0, index), result.userMessage, result.assistantMessage],
        }))
        return result.assistantMessage.id
      },
      () => updateConversation(conversation.id, (current) => ({ ...current, messages: previous })),
    )
  }

  async function regenerate() {
    const conversation = activeConversation
    if (!conversation || sending) return
    setRegenerating(true)

    await stream(
      conversation.id,
      async (signal, onToken) => {
        const result = await api.regenerate(conversation.id, { signal, onToken, onReasoning, onStep })
        if (isPaused(result)) return 'paused'
        updateConversation(conversation.id, (current) => ({
          ...current,
          messages: [...current.messages.slice(0, -1), result.assistantMessage],
        }))
        return result.assistantMessage.id
      },
      () => undefined,
    )
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopiedId(message.id)
      setTimeout(() => setCopiedId((current) => (current === message.id ? null : current)), 1500)
    } catch {
      setError(t('error.copy'))
    }
  }

  async function deleteConversation(id: string) {
    if (sending) return
    setError('')
    try {
      await api.deleteConversation(id)
      const remaining = conversations.filter((item) => item.id !== id)
      setConversations(remaining)
      if (activeId === id) setActiveId(remaining[0]?.id ?? null)
    } catch (cause) {
      fail(cause, 'error.deleteConversation')
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && pickerRef.current?.handleKey(event)) return
    if (event.key !== 'Enter' || event.shiftKey) return
    // Préférence : Entrée envoie, sinon Ctrl/Cmd + Entrée.
    if (preferences.sendOnEnter || event.ctrlKey || event.metaKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const messages = activeConversation?.messages ?? []
  const assistantName = activeAgent?.name ?? (responder.kind === 'model' ? responder.label : 'Snowfall')
  const lastAssistantId = messages.at(-1)?.role === 'assistant' ? messages.at(-1)?.id : undefined
  const shownMessages = regenerating ? messages.slice(0, -1) : messages
  const uploading = activeFiles.some((file) => file.status === 'uploading')
  const canSend =
    (input.trim().length > 0 || activeFiles.some((file) => file.status === 'ready')) &&
    !uploading &&
    !sending &&
    !!activeConversation &&
    !messagesLoading &&
    canWrite

  return (
    <ArtifactContext.Provider value={setArtifact}>
    <main className={`snowfall-app ${artifact ? 'with-artifact' : ''}`}>
      <Snowfall />

      <Sidebar
        conversations={conversations}
        visibleConversations={visibleConversations}
        projects={projects}
        activeProjectId={activeProjectId}
        activeId={activeId}
        username={username}
        historyLoading={historyLoading}
        creating={creating}
        sidebarOpen={sidebarOpen}
        sidebarCollapsed={sidebarCollapsed}
        sidebarPanel={sidebarPanel}
        search={search}
        searchResults={shownResults}
        pinnedIds={pinnedIds}
        onNewChat={() => void newChat()}
        onSelectConversation={(id) => {
          setActiveId(id)
          setSidebarOpen(false)
          setError('')
        }}
        onDeleteConversation={(id) => void deleteConversation(id)}
        onRenameConversation={(id, title) => void renameConversation(id, title)}
        onMoveConversation={(id, projectId) => void moveConversation(id, projectId)}
        onTogglePinned={togglePinned}
        onLogout={() => void endSession()}
        onSearchChange={setSearch}
        onSidebarOpenChange={setSidebarOpen}
        onSidebarCollapsedChange={setSidebarCollapsed}
        onSidebarPanelChange={setSidebarPanel}
        onProjectSelect={(id) => {
          setActiveProjectId(id)
          setSidebarPanel('projects')
          const first = conversations.find((item) => (id ? item.projectId === id : true))
          setActiveId(first?.id ?? null)
        }}
        onCreateProject={(name) => void createProject(name)}
        onRenameProject={(id, name) => void renameProject(id, name)}
        onDeleteProject={(id) => void deleteProject(id)}
        agents={agents}
        activeAgentId={activeAgent?.id ?? null}
        onCreateAgent={() => openAgentEditor(null)}
        onStartAgent={(agent) => void newChat(agent)}
        onEditAgent={openAgentEditor}
        agentEditor={studioAgent}
        onAgentEditorClose={() => setStudioAgent(undefined)}
        agentEditorNotice={studioNotice}
        onAgentSaved={(saved, notice) => {
          const isNew = !agents.some((agent) => agent.id === saved.id)
          setAgents((current) =>
            isNew ? [...current, saved] : current.map((agent) => (agent.id === saved.id ? saved : agent)),
          )
          // Documents refusés à la création : on reste sur l'agent pour que l'utilisateur voie et corrige.
          setStudioNotice(notice)
          if (notice) {
            setStudioAgent(saved)
            return
          }
          setStudioAgent(undefined)
          if (isNew) void newChat(saved)
        }}
        onAgentDeleted={(id) => {
          setAgents((current) => current.filter((agent) => agent.id !== id))
          // Les conversations restent, rattachées au modèle par défaut.
          setConversations((current) => current.map((item) => (item.agentId === id ? { ...item, agentId: null } : item)))
          setStudioAgent(undefined)
        }}
        preferences={preferences}
        onPreferencesChange={savePreferences}
      />

      <section className="chat-workspace">
        <header className="chat-topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu-button"
              aria-label={t('sidebar.menuOpen')}
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </button>
            {activeAgent && (
              <span className="topbar-agent">
                <AgentAvatar avatar={activeAgent.avatar} size={24} mood={agentMood} />
                {activeAgent.name}
                <ProviderLogo provider={activeAgent.provider} size={12} />
              </span>
            )}
            {responder.kind === 'model' && (
              <span className="topbar-agent topbar-model">
                <ProviderLogo provider={responder.provider} size={14} />
                {responder.label}
              </span>
            )}
            <span className="topbar-current">{activeConversation?.title ?? t('chat.newConversation')}</span>
          </div>

          <div className="topbar-right">
            <LanguageSwitcher onChange={(locale) => savePreferences({ ...preferences, locale })} />
          </div>
        </header>

        <div
          className={`chat-content ${conversationIsEmpty ? 'chat-content-empty' : ''} ${dragging ? 'chat-dragging' : ''}`}
          onDragOver={(event) => {
            if (!activeConversation || !canWrite || !event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
          }}
          onDrop={onDrop}
        >
          {/* Logo en fond : centré à l'accueil, il « se couche » derrière le
              composer dès que la conversation commence. */}
          <img
            src="/logo.png"
            alt=""
            aria-hidden="true"
            className={`snowfall-sun ${conversationIsEmpty ? '' : 'snowfall-sun-set'}`}
          />
          {dragging && <div className="drop-overlay">{t('chat.dropFiles')}</div>}

          <div className="chat-scroll-area">
            {historyLoading || messagesLoading ? (
              <div className="welcome">
                <div className="typing-indicator" aria-label={t('common.loading')}>
                  <span />
                  <span />
                  <span />
                </div>
                <p className="welcome-description">{t('chat.loading')}</p>
              </div>
            ) : conversationIsEmpty ? (
              <section className="welcome">
                <h1>
                  <span className="welcome-brand">Snowfall</span>
                  <br />
                  <span>{t('chat.workspace')}</span>
                </h1>
                <p className="welcome-description">{activeConversation ? t('chat.startHint') : t('chat.createHint')}</p>
              </section>
            ) : (
              <section className="messages" aria-live="polite">
                {shownMessages.map((message, messageIndex) => (
                  <article className={`message message-${message.role}`} key={message.id}>
                    <div
                      className={`message-avatar ${message.role === 'assistant' && activeAgent ? `message-avatar-agent message-avatar-${activeAgent.avatar.kind}` : ''}`}
                    >
                      {message.role === 'user' ? (
                        <img src="/logo.png" alt="" className="message-user-logo" />
                      ) : activeAgent ? (
                        <MessageAgentAvatar avatar={activeAgent.avatar} />
                      ) : responder.kind === 'model' ? (
                        <span className="message-badge">
                          <ProviderLogo provider={responder.provider} size={16} />
                        </span>
                      ) : (
                        <span className="message-badge">✳</span>
                      )}
                    </div>
                    <div className="message-body">
                      <div className="message-author">
                        {message.role === 'user' ? username : assistantName}
                      </div>

                      {message.attachments?.length ? (
                        <div className="message-attachments">
                          {message.attachments.map((file) => (
                            <AttachmentChip key={file.id} attachment={file} name={file.name} size={file.size} kind={file.kind} />
                          ))}
                        </div>
                      ) : null}

                      {editing?.id === message.id ? (
                        <form
                          className="message-edit"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void submitEdit()
                          }}
                        >
                          <textarea
                            autoFocus
                            aria-label={t('chat.edit')}
                            value={editing.text}
                            maxLength={4000}
                            onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setEditing(null)
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault()
                                void submitEdit()
                              }
                            }}
                          />
                          <div className="message-edit-actions">
                            <button type="button" onClick={() => setEditing(null)}>
                              {t('common.cancel')}
                            </button>
                            <button type="submit" className="primary">
                              {t('chat.editSave')}
                            </button>
                          </div>
                        </form>
                      ) : message.role === 'assistant' ? (
                        <>
                          {reasoningByMessage[message.id] && <Reasoning text={reasoningByMessage[message.id]!} />}
                          <Markdown source={message.content} showCode={wantsCode(shownMessages[messageIndex - 1]?.content ?? '')} />
                          {activeConversation &&
                            (() => {
                              const files = (generatedFiles[activeConversation.id] ?? []).filter((file) => file.messageId === message.id)
                              return files.length ? <MessageFiles conversationId={activeConversation.id} files={files} /> : null
                            })()}
                          {message.sources?.length ? <MessageSources sources={message.sources} /> : null}
                        </>
                      ) : (
                        message.content && <p>{message.content}</p>
                      )}

                      {editing?.id !== message.id && (
                        <div className="message-actions">
                          {message.role === 'assistant' ? (
                            <>
                              <button
                                className="copy-message"
                                aria-label={copiedId === message.id ? t('chat.copied') : t('chat.copyAnswer')}
                                title={copiedId === message.id ? t('chat.copied') : t('chat.copy')}
                                onClick={() => void copyMessage(message)}
                              >
                                {copiedId === message.id ? <Check size={14} /> : <Copy size={14} />}
                              </button>
                              {message.id === lastAssistantId && canWrite && (
                                <button
                                  className="copy-message"
                                  aria-label={t('chat.regenerate')}
                                  title={t('chat.regenerate')}
                                  disabled={sending}
                                  onClick={() => void regenerate()}
                                >
                                  <RefreshCw size={14} />
                                </button>
                              )}
                            </>
                          ) : (
                            canWrite && (
                              <button
                                className="copy-message"
                                aria-label={t('chat.edit')}
                                title={t('chat.edit')}
                                disabled={sending}
                                onClick={() => setEditing({ id: message.id, text: message.content })}
                              >
                                <Pencil size={14} />
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                ))}

                {sending && (
                  <div className="message message-assistant">
                    <div className={`message-avatar ${activeAgent ? `message-avatar-agent message-avatar-${activeAgent.avatar.kind}` : ''}`}>
                      {activeAgent ? (
                        <MessageAgentAvatar avatar={activeAgent.avatar} mood={agentMood} />
                      ) : responder.kind === 'model' ? (
                        <span className="message-badge">
                          <ProviderLogo provider={responder.provider} size={16} />
                        </span>
                      ) : (
                        <span className="message-badge">✳</span>
                      )}
                    </div>
                    <div className="message-body">
                      <div className="message-author">{assistantName}</div>
                      {reasoning && <Reasoning text={reasoning} thinking={!streamingText && !paused} />}
                      {agentSteps.length > 0 && <AgentSteps steps={agentSteps} onDecide={decideApproval} />}
                      {streamingText ? (
                        <Markdown source={streamingText} showCode={wantsCode(shownMessages.at(-1)?.role === 'user' ? shownMessages.at(-1)!.content : '')} />
                      ) : (
                        <div className="typing-indicator" aria-label={t('chat.answering')}>
                          <span />
                          <span />
                          <span />
                        </div>
                      )}
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
                <button onClick={() => setError('')} aria-label={t('common.close')}>
                  <X size={14} />
                </button>
              </div>
            )}

            <div className="composer">
              {conversationIsEmpty && activeConversation && !historyLoading && !messagesLoading && (
                canWrite ? (
                  <ResponderPicker
                    controlRef={pickerRef}
                    current={responder}
                    agents={agents}
                    providers={catalog.providers}
                    open={pickerOpen}
                    mention={mention?.query ?? null}
                    onOpenChange={(open) => (open ? setPickerOpen(true) : closePicker())}
                    onPick={pickResponder}
                  />
                ) : (
                  activeAgent && (
                    <div className="composer-peek" aria-hidden="true">
                      <span className="composer-peek-halo" />
                      <div className="composer-peek-window">
                        <AgentAvatar avatar={activeAgent.avatar} size={120} mood="hello" />
                      </div>
                    </div>
                  )
                )
              )}
              {activeFiles.length > 0 && (
                <div className="composer-attachments">
                  {activeFiles.map((file) => (
                    <AttachmentChip
                      key={file.localId}
                      {...(file.attachment ? { attachment: file.attachment } : {})}
                      name={file.name}
                      size={file.size}
                      kind={file.kind}
                      status={file.status}
                      {...(file.preview ? { preview: file.preview } : {})}
                      onRemove={() => removePendingFile(file)}
                    />
                  ))}
                </div>
              )}
              {(agentKnowledge > 0 || projectKnowledge > 0) && activeConversation && (
                <div className="composer-knowledge">
                  {agentKnowledge > 0 && (
                    <button
                      type="button"
                      className={`knowledge-toggle ${activeConversation.knowledge.agent ? 'on' : ''}`}
                      aria-pressed={activeConversation.knowledge.agent}
                      disabled={!canWrite || sending}
                      onClick={() => void toggleKnowledge('agent')}
                    >
                      <BookOpen size={12} />
                      {t('knowledge.toggleAgent')}
                      <small>{agentKnowledge}</small>
                    </button>
                  )}
                  {projectKnowledge > 0 && (
                    <button
                      type="button"
                      className={`knowledge-toggle ${activeConversation.knowledge.project ? 'on' : ''}`}
                      aria-pressed={activeConversation.knowledge.project}
                      disabled={!canWrite || sending}
                      onClick={() => void toggleKnowledge('project')}
                    >
                      <BookOpen size={12} />
                      {t('knowledge.toggleProject')}
                      <small>{projectKnowledge}</small>
                    </button>
                  )}
                </div>
              )}
              <div className="composer-toolbar">
                <div className="composer-hints">
                  <button
                    className="attachment-button"
                    type="button"
                    aria-label={t('chat.attach')}
                    title={t('chat.attach')}
                    disabled={!activeConversation || !canWrite || messagesLoading}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Paperclip size={16} />
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    hidden
                    multiple
                    accept={ACCEPT}
                    onChange={(event) => {
                      void addFiles([...(event.target.files ?? [])])
                      event.target.value = ''
                    }}
                  />
                </div>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => onComposerChange(event.target.value, event.target.selectionStart)}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={onPaste}
                  placeholder={conversationIsEmpty && canWrite ? t('chat.placeholderPicker') : t('chat.placeholder')}
                  aria-autocomplete="list"
                  rows={1}
                  aria-label={t('chat.messageLabel')}
                  disabled={!activeConversation || messagesLoading || !canWrite}
                />
                <div className="composer-actions">
                  {sending ? (
                    <button
                      className="send-button stop-button"
                      onClick={stopGeneration}
                      aria-label={t('chat.stop')}
                      title={t('chat.stop')}
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      onClick={() => void sendMessage()}
                      disabled={!canSend}
                      aria-label={t('chat.sendLabel')}
                      title={t('chat.send')}
                    >
                      <ArrowUp size={18} />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="composer-disclaimer">{t('chat.disclaimer')}</p>
          </footer>
        </div>
      </section>
      {artifact && <ArtifactPanel artifact={artifact} onClose={closeArtifact} />}
    </main>
    </ArtifactContext.Provider>
  )
}

let legacyMigration: Promise<void> | null = null

/**
 * Reprise unique des projets autrefois conservés dans le navigateur : créés
 * côté serveur (chiffrés, RLS) puis retirés du stockage local. Mémorisée au
 * niveau du module pour ne jamais s'exécuter deux fois (StrictMode).
 */
function migrateLegacyProjects() {
  legacyMigration ??= (async () => {
    const legacy = readLegacyProjects()
    if (legacy.length === 0) return
    if ((await api.listProjects()).length === 0) {
      const known = new Set((await api.listConversations()).map((item) => item.id))
      for (const old of legacy) {
        const created = await api.createProject(old.name)
        for (const conversationId of old.conversationIds.filter((id) => known.has(id))) {
          await api.updateConversation(conversationId, { projectId: created.id }).catch(() => undefined)
        }
      }
    }
    try {
      localStorage.removeItem(LEGACY_PROJECTS_KEY)
    } catch {
      // Rien à nettoyer.
    }
  })().catch(() => undefined)
  return legacyMigration
}

/** Projets autrefois enregistrés dans le navigateur (avant leur passage côté serveur). */
function readLegacyProjects(): { name: string; conversationIds: string[] }[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_PROJECTS_KEY) ?? '[]') as unknown
    if (!Array.isArray(saved)) return []
    return saved
      .filter(
        (item): item is { name: string; conversationIds: string[] } =>
          typeof item?.name === 'string' && Array.isArray(item?.conversationIds),
      )
      .map((item) => ({ name: item.name.slice(0, 80), conversationIds: item.conversationIds.filter((id) => typeof id === 'string') }))
  } catch {
    return []
  }
}

export default App
