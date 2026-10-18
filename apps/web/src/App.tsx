import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { getSession, logout as endSession } from './auth/session'
import {
  api,
  type Agent,
  type AttachmentMeta,
  isPaused,
  type KnowledgeOwnerKind,
  type Message,
  type Prompt,
  type MessageFeedback as Feedback,
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
import { ArrowUp, BookOpen, Check, Copy, Hourglass, Menu, Paperclip, Pencil, RefreshCw, Square, X } from 'lucide-react'
import Sidebar, { type SidebarPanel } from './components/Sidebar'
import LanguageSwitcher from './components/LanguageSwitcher'
import { AgentAvatar, MessageAgentAvatar, ProviderLogo } from './components/AgentAvatar'
import AttachmentChip from './components/AttachmentChip'
import Markdown from './components/Markdown'
import MessageSources from './components/MessageSources'
import AgentSteps from './components/AgentSteps'
import Reasoning from './components/Reasoning'
import MessageFiles from './components/MessageFiles'
import BranchSwitcher from './components/BranchSwitcher'
import ConversationMenu from './components/ConversationMenu'
import SharedView from './components/SharedView'
import PromptPicker from './components/PromptPicker'
import PromptVariables from './components/PromptVariables'
import { promptVariables, slashQuery } from './lib/prompts'
import MessageFeedback from './components/MessageFeedback'
import ArtifactPanel from './components/ArtifactPanel'
import { ArtifactContext, artifactsIn, wantsCode } from './lib/artifacts'
import { useArtifactPanel } from './hooks/useArtifactPanel'
import { useRun } from './hooks/useRun'
import { useGeneratedFiles } from './hooks/useGeneratedFiles'
import { usePinnedConversations } from './hooks/usePinnedConversations'
import { migrateLegacyProjects } from './lib/legacy-projects'
import ResponderPicker, { type PickerControl } from './components/ResponderPicker'
import {
  mentionAt,
  modelLabel,
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
  /** Hors historique, sans contenu dans les traces, effacée sous 24 h. */
  temporary?: boolean
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

const defaultPreferences: Preferences = { locale: null, sendOnEnter: true, reduceMotion: 'system', memory: false }
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const ACCEPT = '.pdf,.docx,.txt,.md,.csv,.json,image/png,image/jpeg,image/webp'
const DOCUMENT_MAX = 10 * 1024 * 1024

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

/** Jeton d'un lien de partage, dans le fragment de l'adresse (jamais envoyé au serveur avec elle). */
const readShareToken = () => /^#partage=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? null

const toConversation = (item: {
  id: string
  title: string
  agentId: string | null
  model?: ModelSelection | null
  knowledge?: { agent: boolean; project: boolean }
  projectId: string | null
  temporary?: boolean
  updatedAt: string
}): Conversation => ({
  ...(item.temporary ? { temporary: true } : {}),
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
  // Conversations créées ici : rien à charger depuis le serveur (sinon le message en cours d'envoi serait écrasé).
  const freshIds = useRef(new Set<string>())
  // Mode temporaire : s'applique aux nouvelles conversations jusqu'à ce qu'on le coupe.
  const [temporaryMode, setTemporaryMode] = useState(false)
  const [creating, setCreating] = useState(false)
  const [input, setInput] = useState('')
  const { artifact, openArtifact, closeArtifact } = useArtifactPanel()
  // Lien de partage ouvert (#partage=…) : vue en lecture seule à la place de la conversation.
  const [sharedToken, setSharedToken] = useState(readShareToken)
  useEffect(() => {
    const onHash = () => setSharedToken(readShareToken())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const closeShared = () => {
    history.replaceState(null, '', window.location.pathname)
    setSharedToken(null)
  }
  // Copie des conversations lisible à la fin d'une réponse (ouverture de son artifact).
  const conversationsRef = useRef({ conversations, activeId })
  useEffect(() => {
    conversationsRef.current = { conversations, activeId }
  }, [conversations, activeId])
  const { generatedFiles, refreshFiles } = useGeneratedFiles()
  // Réponse en cours (flux, étapes, réflexion, validations, reprise) : voir hooks/useRun.ts.
  const run = useRun({
    updateMessages: (conversationId, update) => updateConversation(conversationId, (conversation) => ({ ...conversation, messages: update(conversation.messages) })),
    onFinished: finishAnswer,
    onFailed: (cause) => fail(cause, 'error.send'),
    onStart: () => setError(''),
  })
  const { sending, streamingText, agentSteps, paused, regenerating, reasoning, reasoningByMessage } = run
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
  // Bibliothèque de prompts : « / » en début de saisie, puis variables à renseigner.
  const [prompts, setPrompts] = useState<Prompt[]>([])
  const [promptQuery, setPromptQuery] = useState<string | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<Prompt | null>(null)
  const promptPickerRef = useRef<PickerControl>(null)
  const pickerRef = useRef<PickerControl>(null)
  // Sources prêtes par base (« agents:<id> », « projects:<id> ») : affiche les bascules.
  const [knowledgeCounts, setKnowledgeCounts] = useState<Record<string, number>>({})

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const messagesLoading = activeId !== null && loadedId !== activeId
  const activeConversation = conversations.find((conversation) => conversation.id === activeId)
  const listedConversations = useMemo(() => conversations.filter((conversation) => !conversation.temporary), [conversations])
  const temporaryShown = Boolean(activeConversation?.temporary || (!activeConversation && temporaryMode))
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
  const { pinnedIds, togglePinned } = usePinnedConversations()

  // Animations réduites à la demande, en plus de la préférence système.
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', preferences.reduceMotion === 'on')
  }, [preferences.reduceMotion])

  function fail(cause: unknown, fallback: Parameters<typeof t>[0]) {
    setError(cause instanceof Error ? cause.message : t(fallback))
  }

  useEffect(() => {
    // Pendant le streaming, défilement instantané : un défilement animé à
    // chaque fragment saccaderait.
    bottomRef.current?.scrollIntoView({ behavior: streamingText ? 'auto' : 'smooth', block: 'end' })
  }, [activeConversation?.messages, sending, streamingText])

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
    api.listPrompts().then((items) => !cancelled && setPrompts(items)).catch(() => undefined)
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
    if (freshIds.current.delete(id)) return
    let cancelled = false

    async function loadMessages() {
      try {
        const messages = await api.getMessages(id)
        if (cancelled) return
        updateConversation(id, (conversation) => ({ ...conversation, messages }))
        void refreshFiles(id)
        // Réponse encore en cours ou en attente de validation : on la retrouve.
        void run.resume(id)
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

  /** Liste relue depuis le serveur (après un import) : les conversations ouvertes gardent leurs messages. */
  async function reloadConversations() {
    try {
      const history = await api.listConversations()
      setConversations((current) => [
        // Les temporaires ne sont jamais dans l'historique : celle qui est ouverte reste.
        ...current.filter((known) => known.temporary),
        ...history.map((item) => current.find((known) => known.id === item.id) ?? toConversation(item)),
      ])
    } catch (cause) {
      fail(cause, 'error.loadConversations')
    }
  }

  function updateConversation(id: string, updater: (conversation: Conversation) => Conversation) {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === id ? updater(conversation) : conversation)),
    )
  }

  function savePreferences(next: Preferences) {
    setPreferences(next)
    api.savePreferences(next).catch((cause) => fail(cause, 'error.send'))
  }

  /** keepInput : création au premier envoi, le message tapé est gardé. */
  async function newChat(agent?: Agent, options: { keepInput?: boolean; temporary?: boolean } = {}): Promise<Conversation | null> {
    const temporary = options.temporary ?? temporaryMode
    if (creating) return null

    run.detach()
    setError('')
    if (!options.keepInput) setInput('')
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
    // Une conversation temporaire n'est rangée dans aucun projet.
    const base = temporary ? { temporary: true } : activeProjectId ? { projectId: activeProjectId } : {}

    try {
      const created = await api
        .createConversation({ ...base, ...(agent ? { agentId: agent.id } : remembered) })
        // Choix mémorisé refusé entre-temps (modèle retiré, fournisseur interdit) : modèle par défaut.
        .catch((cause: unknown) => {
          if (agent || Object.keys(remembered).length === 0) throw cause
          return api.createConversation(base)
        })
      const conversation = toConversation(created)
      freshIds.current.add(conversation.id)
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)])
      setLoadedId(conversation.id)
      setActiveId(conversation.id)
      requestAnimationFrame(() => inputRef.current?.focus())
      return conversation
    } catch (cause) {
      fail(cause, 'error.createConversation')
      return null
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
    setPromptQuery(canWrite ? slashQuery(value) : null)
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

  /**
   * Copie d'un agent (le mien ou celui d'un collègue) : profil, modèle, outils.
   * La base de connaissances n'est pas copiée : ses documents restent ceux de l'original.
   */
  async function duplicateAgent(agent: Agent) {
    try {
      const copy = await api.saveAgent({
        name: `${agent.name.slice(0, 31)} ${t('agents.copySuffix')}`,
        avatar: agent.avatar,
        instructions: agent.instructions,
        provider: agent.provider,
        model: agent.model,
        tools: agent.tools,
        mcpServers: agent.mcpServers ?? [],
        parameters: agent.parameters ?? {},
      })
      setAgents((current) => [...current, copy])
      openAgentEditor(copy)
    } catch (cause) {
      fail(cause, 'studio.saveFailed')
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
    ? listedConversations.filter((conversation) => conversation.projectId === activeProjectId)
    : listedConversations

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

  /** Réponse terminée : titres et ordre relus, fichiers produits, artifact unique ouvert. */
  async function finishAnswer(conversationId: string, answerId: string | undefined) {
    void refreshFiles(conversationId)
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
    const answer = answerId ? conversationsRef.current.conversations.find((item) => item.id === conversationId)?.messages.find((item) => item.id === answerId) : undefined
    const found = answer ? artifactsIn(answer.content) : []
    if (found.length === 1 && conversationsRef.current.activeId === conversationId) openArtifact(found[0]!)
  }

  async function sendMessage() {
    const message = input.trim()
    const ready = activeFiles.filter((file) => file.status === 'ready' && file.attachment)
    const uploading = activeFiles.some((file) => file.status === 'uploading')

    if ((!message && ready.length === 0) || uploading || sending || messagesLoading || !canWrite) return
    // Aucune conversation ouverte (écran d'accueil) : elle est créée au premier envoi.
    const conversation = activeConversation ?? (await newChat(undefined, { keepInput: true }))
    if (!conversation) return

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

    await run.stream(
      conversationId,
      async (signal, onToken) => {
        const result = await api.sendMessage(
          conversationId,
          { content: message, attachmentIds: attachments.map((file) => file.id) },
          { signal, onToken, ...run.handlers },
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

    await run.stream(
      conversation.id,
      async (signal, onToken) => {
        const result = await api.sendMessage(
          conversation.id,
          { content: text, attachmentIds, editMessageId: original.id },
          { signal, onToken, ...run.handlers },
        )
        if (isPaused(result)) return 'paused'
        updateConversation(conversation.id, (current) => ({
          ...current,
          messages: [...previous.slice(0, index), result.userMessage, result.assistantMessage],
        }))
        // L'ancienne version reste consultable : relecture pour afficher ‹ 1/2 ›.
        void run.refreshMessages(conversation.id).catch(() => undefined)
        return result.assistantMessage.id
      },
      () => updateConversation(conversation.id, (current) => ({ ...current, messages: previous })),
    )
  }

  async function regenerate() {
    const conversation = activeConversation
    if (!conversation || sending) return
    run.setRegenerating(true)

    await run.stream(
      conversation.id,
      async (signal, onToken) => {
        const result = await api.regenerate(conversation.id, { signal, onToken, ...run.handlers })
        if (isPaused(result)) return 'paused'
        updateConversation(conversation.id, (current) => ({
          ...current,
          messages: [...current.messages.slice(0, -1), result.assistantMessage],
        }))
        void run.refreshMessages(conversation.id).catch(() => undefined)
        return result.assistantMessage.id
      },
      () => undefined,
    )
  }

  /** Retour sur une réponse : affiché tout de suite, annulé si l'enregistrement échoue. */
  async function rateMessage(messageId: string, feedback: Feedback | null) {
    const conversation = activeConversation
    if (!conversation) return
    const apply = (value: Feedback | null | undefined) =>
      updateConversation(conversation.id, (current) => ({
        ...current,
        messages: current.messages.map((item) => {
          if (item.id !== messageId) return item
          const next = { ...item }
          if (value) next.feedback = value
          else delete next.feedback
          return next
        }),
      }))
    const previous = conversation.messages.find((item) => item.id === messageId)?.feedback
    apply(feedback)
    try {
      await api.setFeedback(conversation.id, messageId, feedback)
    } catch (cause) {
      apply(previous)
      fail(cause, 'error.send')
    }
  }

  /** Autre version d'un message : la conversation affiche sa branche. */
  async function selectBranch(messageId: string) {
    const conversation = activeConversation
    if (!conversation || sending) return
    setEditing(null)
    try {
      const messages = await api.selectBranch(conversation.id, messageId)
      updateConversation(conversation.id, (current) => ({ ...current, messages }))
    } catch (cause) {
      fail(cause, 'error.send')
    }
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

  /**
   * Bascule du mode temporaire. Le caractère temporaire est fixé à la création :
   * une conversation encore vide est remplacée par une nouvelle, dans le bon mode.
   */
  async function toggleTemporary() {
    const next = !temporaryMode
    setTemporaryMode(next)
    const previous = activeConversation
    if (!previous || previous.messages.length > 0) return
    const agent = previous.agentId ? agents.find((item) => item.id === previous.agentId) : undefined
    const created = await newChat(agent, { temporary: next, keepInput: true })
    if (!created) return
    setConversations((current) => current.filter((item) => item.id !== previous.id))
    api.deleteConversation(previous.id).catch(() => undefined)
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

  /** Prompt choisi : inséré tel quel, ou après avoir renseigné ses variables. */
  function applyPrompt(prompt: Prompt) {
    setPromptQuery(null)
    setSidebarOpen(false)
    if (promptVariables(prompt.content).length) {
      setPendingPrompt(prompt)
      return
    }
    setInput(prompt.content)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (promptQuery !== null && promptPickerRef.current?.handleKey(event)) return
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
    !creating &&
    !messagesLoading &&
    canWrite

  return (
    <ArtifactContext.Provider value={openArtifact}>
    <main className={`snowfall-app ${artifact ? 'with-artifact' : ''}`}>
      <Snowfall />

      <Sidebar
        conversations={listedConversations}
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
        onDuplicateAgent={(agent) => void duplicateAgent(agent)}
        agentModelLabel={(agent) => modelLabel(catalog.providers, { provider: agent.provider, model: agent.model })}
        currentUserId={session.user.userId}
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
        onConversationsImported={() => void reloadConversations()}
        prompts={prompts}
        canWrite={canWrite}
        onPromptsChange={setPrompts}
        onUsePrompt={applyPrompt}
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
            {activeAgent && !sharedToken && (
              <span className="topbar-agent">
                <AgentAvatar avatar={activeAgent.avatar} size={24} mood={agentMood} />
                {activeAgent.name}
                <ProviderLogo provider={activeAgent.provider} size={12} />
              </span>
            )}
            {responder.kind === 'model' && !sharedToken && (
              <span className="topbar-agent topbar-model">
                <ProviderLogo provider={responder.provider} size={14} />
                {responder.label}
              </span>
            )}
            <span className="topbar-current">{sharedToken ? t('share.viewTitle') : (activeConversation?.title ?? t('chat.newConversation'))}</span>
          </div>

          <div className="topbar-right">
            {!sharedToken && canWrite && (!activeConversation || activeConversation.messages.length === 0) ? (
              <button
                type="button"
                className={`icon-button chat-temporary-toggle${temporaryShown ? ' active' : ''}`}
                aria-pressed={temporaryShown}
                aria-label={t('temporary.toggle')}
                title={t('temporary.toggle')}
                onClick={() => void toggleTemporary()}
              >
                <Hourglass size={16} />
              </button>
            ) : (
              activeConversation?.temporary && !sharedToken && (
                <span className="chat-temporary-badge" title={t('temporary.notice')}>
                  <Hourglass size={13} />
                  {t('temporary.badge')}
                </span>
              )
            )}
            {activeConversation && activeConversation.messages.length > 0 && !sharedToken && (
              <ConversationMenu
                conversationId={activeConversation.id}
                title={activeConversation.title}
                messages={activeConversation.messages}
                canShare={canWrite && !activeConversation.temporary}
                onError={setError}
              />
            )}
            <LanguageSwitcher onChange={(locale) => savePreferences({ ...preferences, locale })} />
          </div>
        </header>

        {sharedToken && <SharedView token={sharedToken} onClose={closeShared} />}
        <div
          hidden={Boolean(sharedToken)}
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
                          {message.branch && <BranchSwitcher branch={message.branch} disabled={sending} onSelect={(id) => void selectBranch(id)} />}
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
                              {canWrite && (
                                <MessageFeedback feedback={message.feedback} disabled={sending} onChange={(feedback) => rateMessage(message.id, feedback)} />
                              )}
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
                      {agentSteps.length > 0 && <AgentSteps steps={agentSteps} onDecide={run.decide} />}
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

          <footer className="composer-area" hidden={Boolean(sharedToken)}>
            {error && (
              <div className="error-notice" role="alert">
                <span>{error}</span>
                <button onClick={() => setError('')} aria-label={t('common.close')}>
                  <X size={14} />
                </button>
              </div>
            )}

            <div className="composer">
              {promptQuery !== null && (
                <PromptPicker prompts={prompts} query={promptQuery} controlRef={promptPickerRef} onPick={applyPrompt} onClose={() => setPromptQuery(null)} />
              )}
              {pendingPrompt && (
                <PromptVariables
                  prompt={pendingPrompt}
                  onCancel={() => setPendingPrompt(null)}
                  onInsert={(text) => {
                    setPendingPrompt(null)
                    setInput(text)
                    requestAnimationFrame(() => inputRef.current?.focus())
                  }}
                />
              )}
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
                  disabled={messagesLoading || !canWrite}
                />
                <div className="composer-actions">
                  {sending ? (
                    <button
                      className="send-button stop-button"
                      onClick={run.stop}
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
            <p className="composer-disclaimer">{temporaryShown ? t('temporary.notice') : t('chat.disclaimer')}</p>
          </footer>
        </div>
      </section>
      {artifact && <ArtifactPanel key={artifact.opening} artifact={artifact} onClose={closeArtifact} />}
    </main>
    </ArtifactContext.Provider>
  )
}

export default App
