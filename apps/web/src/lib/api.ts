import { login } from '../auth/session'
import { t } from './i18n'

export type AttachmentMeta = {
  id: string
  name: string
  kind: 'document' | 'image'
  mediaType: string
  size: number
  messageId: string | null
  createdAt: string
}

/** Source de la base de connaissances citée par une réponse ([n]). */
export type MessageSource = {
  n: number
  sourceId: string
  name: string
  url: string | null
  /** web : page trouvée par la recherche web. */
  base: 'agent' | 'project' | 'web'
  /** Section (« Partie > Sous-partie ») et page du passage cité. */
  section?: string | null
  page?: number | null
}

/** Fichier produit par l'interpréteur de code, rattaché à une réponse. */
export type GeneratedFile = { id: string; name: string; mediaType: string; size: number; messageId: string; createdAt: string }

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  attachments?: AttachmentMeta[]
  sources?: MessageSource[]
  /** Versions de ce tour (modification, régénération), s'il y en a plusieurs. */
  branch?: MessageBranch
  /** Ton retour sur une réponse. */
  feedback?: MessageFeedback
}

export type MessageFeedback = { rating: 'up' | 'down'; comment?: string }

export type MessageBranch = { index: number; count: number; siblings: string[] }

/** Prompt de la bibliothèque : privé, ou partagé avec l'organisation. */
export type Prompt = { id: string; name: string; content: string; shared: boolean; mine: boolean; updatedAt: string }
export type PromptInput = { name: string; content: string; shared: boolean }

/** Lien de partage interne (le jeton est le secret du lien). */
export type ShareLink = { id: string; token: string; expiresAt: string; createdAt: string }

/** Conversation partagée ouverte : instantané figé au moment du partage. */
export type OpenedShare = {
  id: string
  title: string
  expiresAt: string
  createdAt: string
  mine: boolean
  snapshot: {
    agent?: { name: string; avatar: AgentAvatarData }
    messages: { role: 'user' | 'assistant'; content: string; createdAt: string; sources?: { n: number; name: string }[] }[]
  }
}

export type KnowledgeOwnerKind = 'agents' | 'projects'

export type KnowledgeSource = {
  id: string
  kind: 'file' | 'link'
  status: 'pending' | 'processing' | 'ready' | 'error'
  errorCode: string | null
  name: string
  url: string | null
  mediaType: string | null
  size: number
  chunkCount: number
  embeddingModel: string | null
  createdAt: string
  updatedAt: string
}

export type KnowledgeBaseView = {
  id: string | null
  confidential: boolean
  canManage: boolean
  /** Modèle d'embeddings de l'organisation pour cette base ; null = mots-clés. */
  embeddingModel: string | null
  linksEnabled: boolean
  sources: KnowledgeSource[]
}

export type ConversationSummary = {
  id: string
  title: string
  agentId: string | null
  /** Modèle choisi pour une conversation sans agent (null : modèle par défaut). */
  model: ModelSelection | null
  /** Bases de connaissances consultées (agent, projet). */
  knowledge?: { agent: boolean; project: boolean }
  projectId: string | null
  /** Conversation temporaire : hors historique, effacée sous 24 h. */
  temporary?: boolean
  createdAt: string
  updatedAt: string
}

export type SearchHit = { id: string; title: string; snippet?: string }

export type Project = {
  id: string
  name: string
  conversationCount: number
  createdAt: string
  updatedAt: string
}

export type ProviderId = 'mistral' | 'openai' | 'anthropic' | 'google' | 'local'
export const providerIds = ['mistral', 'openai', 'anthropic', 'google', 'local'] as const

export type ModelSelection = { provider: ProviderId; model: string }

export type ProviderCatalog = {
  id: ProviderId
  available: boolean
  /** Autorisé par l'organisation (réglage d'administration). */
  allowed?: boolean
  models: { id: string; label: string }[]
}

export const alienColors = ['pink', 'coral', 'mint', 'lavender', 'sky', 'lime', 'snow', 'gold'] as const
export const alienEyes = ['classic', 'round', 'sleepy', 'happy', 'wink', 'sparkle'] as const
export const alienAccessories = [
  'none', 'antenna', 'headset', 'bow', 'crown', 'scarf',
  'flower', 'cap', 'halo', 'helmet', 'ufo', 'tie',
] as const

export type AlienAvatar = {
  kind: 'alien'
  color: (typeof alienColors)[number]
  eyes: (typeof alienEyes)[number]
  accessory: (typeof alienAccessories)[number]
}

export type AgentAvatarData = AlienAvatar | { kind: 'image'; data: string }

/** Outils d'agent ; write = demande ton accord à chaque utilisation. */
export const toolIds = ['search_knowledge', 'save_to_knowledge', 'web_search', 'code_interpreter', 'mcp'] as const
export type ToolId = (typeof toolIds)[number]
export const toolAccess: Record<ToolId, 'read' | 'write'> = {
  search_knowledge: 'read',
  save_to_knowledge: 'write',
  web_search: 'read',
  code_interpreter: 'read',
  // Accès réel fixé outil par outil par l'admin ; les écritures demandent ton accord.
  mcp: 'write',
}

export type AgentInput = {
  name: string
  avatar: AgentAvatarData
  instructions: string
  provider: ProviderId
  model: string
  tools: ToolId[]
  /** Serveurs MCP approuvés confiés à l'agent (outil « mcp »). */
  mcpServers: string[]
  /** Réglages des réponses ; absents : ceux du fournisseur. */
  parameters?: AgentParameters
}

export type AgentParameters = { creativity?: 'precise' | 'balanced' | 'creative'; length?: 'concise' | 'complete' }

export type Agent = AgentInput & {
  id: string
  createdBy: string | null
  canEdit: boolean
  /** Réponses jugées utiles dans l'organisation (présent à partir de 5 avis). */
  rating?: { up: number; total: number }
}

export type Role = 'owner' | 'admin' | 'member' | 'reader'

export type Preferences = {
  locale: 'fr' | 'en' | null
  sendOnEnter: boolean
  reduceMotion: 'system' | 'on' | 'off'
  /** Mémoire activée (désactivée par défaut). */
  memory: boolean
}

/** Fait retenu à la demande de l'utilisateur. */
export type UserMemory = { id: string; content: string; createdAt: string }

export type UsageTotals = { inputTokens: number; outputTokens: number }

export type Usage = {
  usage: {
    period: string
    total: UsageTotals
    byProvider: Partial<Record<ProviderId | 'echo', UsageTotals>>
    mine: UsageTotals
    /** Appels d'outils du mois, pour l'organisation. */
    tools?: Partial<Record<ToolMeter, number>>
  }
  limits: { monthly: number | null; providers: Partial<Record<ProviderId, number>>; tools?: Partial<Record<ToolMeter, number>> }
}

export type EmbeddingProvider = 'mistral' | 'openai' | 'google' | 'local'

export type OrganizationSettings = {
  allowedProviders: ProviderId[]
  monthlyTokenLimit: number | null
  providerTokenLimits: Partial<Record<ProviderId, number>>
  /** Embeddings des bases de connaissances ; null = mots-clés seulement. */
  embeddingProvider: EmbeddingProvider | null
  linksEnabled: boolean
  linkDomains: string[]
  /** Outils que les agents de l'organisation peuvent utiliser. */
  tools: ToolId[]
  /** Plafonds mensuels d'appels d'outils ; absent = illimité. */
  toolLimits: Partial<Record<ToolMeter, number>>
}

/** Catégories d'outils comptées (code, web, MCP) et l'outil qui les active. */
export const toolMeters = [
  { id: 'code', tool: 'code_interpreter' },
  { id: 'web', tool: 'web_search' },
  { id: 'mcp', tool: 'mcp' },
] as const satisfies readonly { id: string; tool: ToolId }[]
export type ToolMeter = (typeof toolMeters)[number]['id']

export type Organization = {
  organization: { id: string; name: string; sso?: { alias: string | null; defaultRole: 'member' | 'reader' } }
  settings: OrganizationSettings
  configuredProviders: ProviderId[]
  /** Fournisseurs configurés pour les embeddings sur la plateforme. */
  embeddingProviders?: EmbeddingProvider[]
  /** Outils que la plateforme sait fournir (la recherche web exige SearXNG). */
  platformTools?: ToolId[]
}

/** Serveur MCP de l'organisation ; url et hasToken : administrateurs seulement. */
export type McpServer = {
  id: string
  name: string
  status: 'pending' | 'approved' | 'disabled'
  url?: string
  hasToken?: boolean
  tools: { name: string; title: string | null; access: 'read' | 'write' }[]
}

/** Outil publié par un serveur, à examiner avant approbation. */
export type McpDiscoveredTool = {
  name: string
  title: string | null
  description: string
  readOnlyHint: boolean
  supported: boolean
  approved: boolean
  /** Empreinte de la définition affichée : l'approbation échoue si le serveur l'a changée depuis. */
  fingerprint: string
  /** Schéma des paramètres : leurs descriptions sont lues par le modèle. */
  inputSchema: { properties?: Record<string, { description?: unknown; type?: unknown }> }
}

export type Member = { userId: string; email: string; role: Role; joinedAt: string; monthlyTokens: number }
export type Invitation = { id: string; email: string; role: Exclude<Role, 'owner'>; createdAt: string; expiresAt: string }

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function errorMessage(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string }
  const knowledge = body.reason ? knowledgeError(body.reason) : null
  if (knowledge) return knowledge
  if (body.reason === 'provider_quota_exceeded') return t('error.providerQuota')
  if (body.reason === 'quota_exceeded') return t('error.quota')
  if (body.error === 'Provider not allowed') return t('error.providerNotAllowed')
  if (body.error === 'Malware detected') return t('error.malware')
  if (body.error === 'Scanner unavailable') return t('error.scanner')
  if (body.error === 'Unsupported file') return t('error.unsupportedFile')
  if (body.error === 'Unreadable document') return t('error.unreadableFile')
  if (body.error === 'Too many attachments') return t('error.tooManyFiles')
  if (body.error === 'Run in progress') return t('error.runInProgress')
  switch (response.status) {
    case 403:
      return t('error.forbidden')
    case 404:
      return t('error.notFound')
    case 409:
      return t('error.conflict')
    case 413:
      return t('error.fileTooLarge')
    case 429:
      return t('error.tooMany')
    default:
      return t('error.server', { status: response.status })
  }
}

/** Raisons renvoyées par les routes de connaissances, traduites pour l'utilisateur. */
export function knowledgeError(reason: string): string | null {
  switch (reason) {
    case 'confidential_requires_local':
      return t('knowledge.error.confidentialLocal')
    case 'agent_requires_local':
      return t('knowledge.error.agentLocal')
    case 'links_disabled':
      return t('knowledge.error.linksDisabled')
    case 'domain_not_allowed':
      return t('knowledge.error.domain')
    case 'blocked_address':
    case 'invalid_url':
      return t('knowledge.error.invalidLink')
    case 'audio_video':
      return t('knowledge.error.audioVideo')
    case 'image':
      return t('knowledge.error.image')
    case 'unsupported':
      return t('knowledge.error.unsupported')
    case 'too_large':
      return t('error.fileTooLarge')
    case 'too_many_sources':
    case 'too_many_chunks':
      return t('knowledge.error.full')
    default:
      return null
  }
}

async function send(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })

  if (!response.ok) {
    if (response.status === 401) {
      login()
      throw new ApiError(t('error.sessionExpired'), 401)
    }
    throw new ApiError(await errorMessage(response), response.status)
  }

  return response
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await send(path, init)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

/** Action d'écriture en attente de ton accord : aperçu construit par le serveur. */
export type ToolApproval = {
  id: string
  title: string
  detail: string
  /** Un contenu lu pendant la réponse contenait des consignes adressées à l'assistant. */
  warning?: boolean
  /** Appel sortant d'une réponse qui a lu un contenu externe ET des données internes. */
  exposure?: boolean
}

/** Étape d'un agent pendant la réponse (appel d'outil). */
export type AgentStep = {
  id: string
  name: string
  /** denied : action refusée (par toi, ou faute de réponse). */
  status: 'running' | 'done' | 'error' | 'denied'
  summary?: string
  approval?: ToolApproval
}

type StreamOptions = {
  onToken?: (text: string) => void
  /** Réflexion du modèle, au fil de l'eau (jamais enregistrée). */
  onReasoning?: (text: string) => void
  onStep?: (step: AgentStep) => void
  /** Reconnexion : avancement déjà produit (texte, étapes, validations en attente). */
  onSnapshot?: (snapshot: RunSnapshot) => void
  signal?: AbortSignal
}

/** La réponse attend ta validation : elle reprendra après ta décision (même plus tard). */
export type RunPaused = { paused: true }
export const isPaused = (value: unknown): value is RunPaused => typeof value === 'object' && value !== null && 'paused' in value

/** Réponse en cours côté serveur (exécution durable). */
export type RunSnapshot = {
  status: 'running' | 'waiting'
  text: string
  reasoning?: string
  steps: AgentStep[]
  approvals: (ToolApproval & { stepId: string; tool: string })[]
}

export type ActiveRun = RunSnapshot & { id: string; kind: 'message' | 'regenerate'; question: string }

/** Demande de validation reçue du serveur, rattachée à son étape. */
export const approvalStep = (payload: { id: unknown; stepId: unknown; tool: unknown; title: unknown; detail?: unknown; warning?: unknown; exposure?: unknown }): AgentStep => ({
  id: String(payload.stepId),
  name: String(payload.tool),
  status: 'running',
  approval: { id: String(payload.id), title: String(payload.title), detail: String(payload.detail ?? ''), ...(payload.warning === true ? { warning: true } : {}), ...(payload.exposure === true ? { exposure: true } : {}) },
})

/**
 * Réponse en Server-Sent Events : onToken reçoit chaque fragment. Se termine
 * par le résultat, ou par une pause (validation attendue). body absent : GET
 * (reprise du fil d'une réponse en cours).
 */
async function stream<T>(path: string, body: unknown, options: StreamOptions): Promise<T | RunPaused> {
  const response = await send(path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!response.body) throw new Error(t('error.emptyResponse'))

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')

      const event = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      if (!event || !data) continue
      const payload = JSON.parse(data)

      if (event === 'step') {
        options.onStep?.(payload as AgentStep)
      } else if (event === 'approval') {
        // L'étape en cours attend ta décision.
        options.onStep?.(approvalStep(payload))
      } else if (event === 'reasoning') {
        options.onReasoning?.(payload.text as string)
      } else if (event === 'snapshot') {
        options.onSnapshot?.(payload as RunSnapshot)
      } else if (event === 'paused') {
        return { paused: true }
      } else if (event === 'token') {
        options.onToken?.(payload.text as string)
      } else if (event === 'done') {
        return payload as T
      } else if (event === 'error') {
        throw new Error(
          payload.error === 'Not found'
            ? t('error.notFound')
            : payload.error === 'Refused'
              ? t('error.refused')
              : payload.error === 'Provider unavailable' || payload.error === 'Local model required'
                ? t('error.providerUnavailable')
                : payload.error === 'Provider rate limited'
                  ? t('error.providerRateLimited')
                : t('error.assistantUnavailable'),
        )
      }
    }
  }

  throw new Error(t('error.interrupted'))
}

async function modelCatalog() {
  const data = await request<{ providers: ProviderCatalog[]; defaultModel?: ModelSelection | null }>('/models')
  return { providers: data.providers, defaultModel: data.defaultModel ?? null }
}

export const api = {
  listConversations: async () => {
    const data = await request<ConversationSummary[] | { conversations: ConversationSummary[] }>('/conversations')
    return Array.isArray(data) ? data : data.conversations
  },

  searchConversations: async (query: string, signal?: AbortSignal) =>
    (
      await request<{ results: SearchHit[] }>(
        `/conversations/search?q=${encodeURIComponent(query)}`,
        signal ? { signal } : {},
      )
    ).results,

  createConversation: async (
    options: { title?: string; agentId?: string; projectId?: string; model?: ModelSelection; temporary?: boolean } = {},
  ) => {
    const data = await request<ConversationSummary | { conversation: ConversationSummary }>(
      '/conversations',
      json('POST', options),
    )
    return 'conversation' in data ? data.conversation : data
  },

  updateConversation: async (
    id: string,
    changes: {
      title?: string
      projectId?: string | null
      agentId?: string | null
      model?: ModelSelection | null
      knowledge?: { agent?: boolean; project?: boolean }
    },
  ) =>
    (await request<{ conversation: ConversationSummary }>(`/conversations/${id}`, json('PATCH', changes))).conversation,

  getMessages: async (id: string) => {
    const data = await request<Message[] | { messages: Message[] }>(`/conversations/${id}/messages`)
    return Array.isArray(data) ? data : data.messages
  },

  sendMessage: (
    id: string,
    input: { content: string; attachmentIds?: string[]; editMessageId?: string },
    options: StreamOptions = {},
  ) => stream<{ userMessage: Message; assistantMessage: Message }>(`/conversations/${id}/messages`, input, options),

  regenerate: (id: string, options: StreamOptions = {}) =>
    stream<{ assistantMessage: Message }>(`/conversations/${id}/regenerate`, {}, options),

  /** Ta réponse à une demande de validation : la réponse reprend, diffusée comme un envoi. */
  decideApproval: (conversationId: string, approvalId: string, approved: boolean, options: StreamOptions = {}) =>
    stream<{ userMessage?: Message; assistantMessage?: Message }>(`/conversations/${conversationId}/approvals/${approvalId}`, { approved }, options),

  /** Réponse en cours dans la conversation (reconnexion), ou null. */
  listMemories: async () => (await request<{ memories: UserMemory[] }>('/me/memories')).memories,
  deleteMemory: (id: string) => request<void>(`/me/memories/${id}`, { method: 'DELETE' }),
  clearMemories: () => request<void>('/me/memories', { method: 'DELETE' }),

  listPrompts: async () => (await request<{ prompts: Prompt[] }>('/prompts')).prompts,
  createPrompt: async (input: PromptInput) => (await request<{ prompt: Prompt }>('/prompts', json('POST', input))).prompt,
  updatePrompt: async (id: string, input: PromptInput) => (await request<{ prompt: Prompt }>(`/prompts/${id}`, json('PUT', input))).prompt,
  deletePrompt: (id: string) => request<void>(`/prompts/${id}`, { method: 'DELETE' }),

  /** Import d'un fichier exporté d'un autre service (ChatGPT, LibreChat, Snowfall). */
  importConversations: (data: unknown) =>
    request<{ imported: number; skipped: number; format: string }>('/conversations/import', json('POST', data)),
  /** Toutes mes données (RGPD), déchiffrées. */
  exportPersonalData: () => request<unknown>('/me/export'),

  createShare: async (conversationId: string, days: number) =>
    (await request<{ share: ShareLink }>(`/conversations/${conversationId}/shares`, json('POST', { days }))).share,
  listShares: async (conversationId: string) => (await request<{ shares: ShareLink[] }>(`/conversations/${conversationId}/shares`)).shares,
  deleteShare: (id: string) => request<void>(`/shares/${id}`, { method: 'DELETE' }),
  /** Le jeton part dans le corps, jamais dans l'adresse (journaux). */
  openShare: async (token: string) => (await request<{ share: OpenedShare }>('/shares/open', json('POST', { token }))).share,

  /** 👍 / 👎 sur une réponse (null : retiré). */
  setFeedback: (conversationId: string, messageId: string, feedback: MessageFeedback | null) =>
    request<{ feedback: MessageFeedback | null }>(
      `/conversations/${conversationId}/messages/${messageId}/feedback`,
      json('PUT', feedback ? feedback : { rating: null }),
    ),

  /** Afficher une autre version d'un message : renvoie la branche affichée. */
  selectBranch: async (conversationId: string, messageId: string) =>
    (await request<{ messages: Message[] }>(`/conversations/${conversationId}/branch`, json('POST', { messageId }))).messages,

  getRun: async (conversationId: string) => (await request<{ run: ActiveRun | null }>(`/conversations/${conversationId}/run`)).run,

  /** Reprendre le fil d'une réponse en cours (avancement, puis la suite en direct). */
  watchRun: (conversationId: string, options: StreamOptions = {}) =>
    stream<{ userMessage?: Message; assistantMessage?: Message; refresh?: boolean }>(`/conversations/${conversationId}/run/events`, undefined, options),

  /** Fichiers produits par l'interpréteur de code dans la conversation. */
  listGeneratedFiles: async (conversationId: string) =>
    (await request<{ files: GeneratedFile[] }>(`/conversations/${conversationId}/files`)).files,
  generatedFileBlob: async (conversationId: string, id: string) => (await send(`/conversations/${conversationId}/files/${id}`)).blob(),

  /** Arrêter la réponse (fermer l'onglet ne l'arrête pas) ; le partiel est gardé. */
  cancelRun: (conversationId: string) => request<void>(`/conversations/${conversationId}/run/cancel`, json('POST', {})),

  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: 'DELETE' }),

  uploadAttachment: async (conversationId: string, file: Blob, name: string) =>
    (
      await request<{ attachment: AttachmentMeta }>(`/conversations/${conversationId}/attachments`, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
      })
    ).attachment,

  deleteAttachment: (id: string) => request<void>(`/attachments/${id}`, { method: 'DELETE' }),

  attachmentBlob: async (id: string) => (await send(`/attachments/${id}/content`)).blob(),

  getKnowledge: async (kind: KnowledgeOwnerKind, id: string) =>
    (await request<{ knowledge: KnowledgeBaseView }>(`/${kind}/${id}/knowledge`)).knowledge,
  setKnowledgeConfidential: (kind: KnowledgeOwnerKind, id: string, confidential: boolean) =>
    request<{ knowledge: { id: string; confidential: boolean } }>(`/${kind}/${id}/knowledge`, json('PATCH', { confidential })),
  addKnowledgeFile: async (kind: KnowledgeOwnerKind, id: string, file: Blob, name: string) =>
    (
      await request<{ source: KnowledgeSource }>(`/${kind}/${id}/knowledge/files`, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
      })
    ).source,
  addKnowledgeLink: async (kind: KnowledgeOwnerKind, id: string, url: string) =>
    (await request<{ source: KnowledgeSource }>(`/${kind}/${id}/knowledge/links`, json('POST', { url }))).source,
  deleteKnowledgeSource: (id: string) => request<void>(`/knowledge/sources/${id}`, { method: 'DELETE' }),
  reindexKnowledgeSource: async (id: string) =>
    (await request<{ source: KnowledgeSource }>(`/knowledge/sources/${id}/reindex`, { method: 'POST' })).source,
  knowledgeSourceBlob: async (id: string) => (await send(`/knowledge/sources/${id}/content`)).blob(),

  listModels: async () => (await modelCatalog()).providers,

  modelCatalog,

  listAgents: async () => (await request<{ agents: Agent[] }>('/agents')).agents,

  saveAgent: async (input: AgentInput, id?: string) =>
    (await request<{ agent: Agent }>(id ? `/agents/${id}` : '/agents', json(id ? 'PUT' : 'POST', input))).agent,

  deleteAgent: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),

  listProjects: async () => (await request<{ projects: Project[] }>('/projects')).projects,
  createProject: async (name: string) => (await request<{ project: Project }>('/projects', json('POST', { name }))).project,
  renameProject: async (id: string, name: string) =>
    (await request<{ project: Project }>(`/projects/${id}`, json('PATCH', { name }))).project,
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

  getPreferences: async () => (await request<{ preferences: Preferences }>('/me/preferences')).preferences,
  savePreferences: async (preferences: Preferences) =>
    (await request<{ preferences: Preferences }>('/me/preferences', json('PUT', preferences))).preferences,

  getUsage: () => request<Usage>('/usage'),
  getOrganization: () => request<Organization>('/organization'),
  saveOrganizationSettings: async (settings: OrganizationSettings) =>
    (await request<{ settings: OrganizationSettings }>('/organization/settings', json('PUT', settings))).settings,
  saveSso: (sso: { alias: string | null; defaultRole: 'member' | 'reader' }) =>
    request<{ sso: typeof sso }>('/organization/sso', json('PUT', sso)),

  listMembers: () => request<{ members: Member[]; invitations: Invitation[] }>('/organization/members'),
  setMemberRole: (userId: string, role: Role) =>
    request<void>(`/organization/members/${userId}`, json('PATCH', { role })),
  removeMember: (userId: string) => request<void>(`/organization/members/${userId}`, { method: 'DELETE' }),
  invite: async (email: string, role: Invitation['role']) =>
    (await request<{ invitation: Invitation }>('/organization/invitations', json('POST', { email, role }))).invitation,
  revokeInvitation: (id: string) => request<void>(`/organization/invitations/${id}`, { method: 'DELETE' }),

  // Serveurs MCP : ajout, examen et approbation par un administrateur.
  listMcpServers: async () => (await request<{ servers: McpServer[] }>('/organization/mcp-servers')).servers,
  createMcpServer: async (input: { name: string; url: string; token?: string }) =>
    (await request<{ server: McpServer }>('/organization/mcp-servers', json('POST', input))).server,
  discoverMcpTools: async (id: string) =>
    (await request<{ tools: McpDiscoveredTool[] }>(`/organization/mcp-servers/${id}/discover`, { method: 'POST' })).tools,
  approveMcpServer: async (id: string, tools: { name: string; access: 'read' | 'write'; fingerprint: string }[]) =>
    (await request<{ server: McpServer }>(`/organization/mcp-servers/${id}/approve`, json('POST', { tools }))).server,
  setMcpServerEnabled: async (id: string, enabled: boolean) =>
    (await request<{ server: McpServer }>(`/organization/mcp-servers/${id}`, json('PATCH', { enabled }))).server,
  deleteMcpServer: (id: string) => request<void>(`/organization/mcp-servers/${id}`, { method: 'DELETE' }),
}
