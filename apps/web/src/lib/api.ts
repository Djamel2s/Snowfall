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
  /** Auteur d'une réponse : « agent:<id> » ou « model:<fournisseur>:<modèle> ». */
  author?: string
  /** Réponse inachevée (longueur maximale, arrêt) : elle peut être continuée. */
  incomplete?: boolean
}

export type MessageFeedback = { rating: 'up' | 'down'; comment?: string }

export type MessageBranch = { index: number; count: number; siblings: string[] }

/** Réglages d'une conversation : priment sur ceux de l'agent (absents : ceux de l'agent). */
export type ConversationSettings = {
  creativity?: 'precise' | 'balanced' | 'creative'
  length?: 'concise' | 'complete'
  instructions?: string
}

/** Compétence : savoir-faire que l'agent charge quand la demande correspond à sa description. */
/** hasOriginal : modèle binaire (Word, PDF, Excel, image) gardé pour les scripts de la compétence. */
export type SkillFile = { id: string; name: string; mediaType: string; size: number; createdAt: string; hasOriginal?: boolean }
export type Skill = {
  id: string
  name: string
  description: string
  instructions: string
  confidential: boolean
  version: number
  mine: boolean
  canEdit: boolean
  shared: boolean
  files: SkillFile[]
  updatedAt: string
}
export type SkillInput = { name: string; description: string; instructions: string; confidential: boolean }

/** Fichier déjà envoyé (« Mes fichiers »), avec sa conversation d'origine. */
export type LibraryFile = AttachmentMeta & { conversationId: string }

/** Préréglage : réglages nommés, privés, réappliqués en un clic. */
export type Preset = { id: string; name: string; settings: ConversationSettings; createdAt: string }

/** Prompt de la bibliothèque : privé, ou partagé avec l'organisation. */
/** Prompt de la bibliothèque : le mien, ou partagé avec moi (lecture ou modification). */
export type Prompt = { id: string; name: string; content: string; mine: boolean; shared: boolean; canEdit: boolean; updatedAt: string }
export type PromptInput = { name: string; content: string }

/** Autorisation sur un agent ou un prompt : une personne, un groupe, ou toute l'organisation. */
export type AccessGrant = {
  principal: { type: 'user'; id: string } | { type: 'group'; id: string } | { type: 'organization' }
  permission: 'view' | 'edit'
}
export type SharingDirectory = { members: { userId: string; email: string }[]; groups: { id: string; name: string; memberCount: number }[] }
export type MemberGroup = { id: string; name: string; memberIds: string[] }

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
  /** Donnée sensible détectée un jour : modèle local, définitivement. */
  sensitive?: boolean
  settings?: ConversationSettings
  archived?: boolean
  tags?: string[]
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
export const toolIds = ['search_knowledge', 'save_to_knowledge', 'web_search', 'code_interpreter', 'mcp', 'delegate', 'image_generation'] as const
export type ToolId = (typeof toolIds)[number]
export const toolAccess: Record<ToolId, 'read' | 'write'> = {
  search_knowledge: 'read',
  save_to_knowledge: 'write',
  web_search: 'read',
  code_interpreter: 'read',
  // Accès réel fixé outil par outil par l'admin ; les écritures demandent ton accord.
  mcp: 'write',
  delegate: 'read',
  image_generation: 'read',
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
  /** Agents spécialistes que celui-ci peut consulter (outil « delegate »). */
  delegates?: string[]
  /** Réglages des réponses ; absents : ceux du fournisseur. */
  parameters?: AgentParameters
  /** Compétences confiées (chargées à la demande par l'agent). */
  skills?: string[]
}

export type AgentParameters = { creativity?: 'precise' | 'balanced' | 'creative'; length?: 'concise' | 'complete' }

export type Agent = AgentInput & {
  id: string
  createdBy: string | null
  canEdit: boolean
  /** Supprimer et partager : son auteur ou un administrateur. */
  canShare?: boolean
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
  theme: 'system' | 'dark' | 'light'
  /** « Qui je suis, comment me répondre » : accompagne chaque message. */
  instructions: string
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
  /** Données sensibles avant un envoi externe : modèle local ou refus (« off » : désactivé). */
  sensitiveData?: 'local' | 'off'
  /** Données personnelles remplacées par des jetons avant un fournisseur externe. */
  pseudonymize?: boolean
  /** Routage automatique (conversations sans agent ni modèle) ; null = désactivé. */
  modelRouting?: { fast: ModelSelection; strong: ModelSelection } | null
}

/** Catégories d'outils comptées (code, web, MCP) et l'outil qui les active. */
export const toolMeters = [
  { id: 'code', tool: 'code_interpreter' },
  { id: 'web', tool: 'web_search' },
  { id: 'mcp', tool: 'mcp' },
  { id: 'image', tool: 'image_generation' },
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
  /** token : jeton partagé de l'organisation ; oauth : chacun avec son compte. */
  auth?: 'token' | 'oauth'
  /** mcp : serveur MCP ; openapi : API décrite par sa spécification. */
  kind?: 'mcp' | 'openapi'
  url?: string
  hasToken?: boolean
  /** Connecteur du catalogue reconnu à son adresse (logo, catégorie). */
  catalogId?: string
  tools: { name: string; title: string | null; access: 'read' | 'write' }[]
}

/** Connecteur connu (serveur MCP publié par son éditeur), ajouté en un clic par un administrateur. */
export type CatalogConnector = {
  id: string
  name: string
  category: string
  description: string
  url: string
  auth: 'oauth' | 'token' | 'none'
  needsClient?: boolean
  scope?: string
  tenant?: boolean
  preview?: boolean
  allowlist?: boolean
  license?: string
  source: 'vendor' | 'directory'
  docs?: string
  icon: string | null
  color: string
}

/** Serveur MCP en mode OAuth, et si l'utilisateur y est connecté avec son compte. */
export type McpConnection = { id: string; name: string; status: 'pending' | 'approved'; connected: boolean }

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
  const body = (await response.json().catch(() => ({}))) as { error?: string; reason?: string; categories?: string[] }
  if (body.reason === 'sensitive_requires_local') {
    const known = ['nir', 'iban', 'card', 'health']
    const categories = (body.categories ?? []).filter((item) => known.includes(item)).map((item) => t(`sensitive.category.${item}` as 'sensitive.category.nir'))
    return t('sensitive.blocked', { categories: categories.join(', ') || t('sensitive.category.health') })
  }
  const knowledge = body.reason ? knowledgeError(body.reason) : null
  if (knowledge) return knowledge
  const quality = body.reason ? qualityError(body.reason) : null
  if (quality) return quality
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
      return body.reason && /^[a-z_]{1,60}$/.test(body.reason)
        ? t('error.serverReason', { status: response.status, reason: body.reason })
        : t('error.server', { status: response.status })
  }
}

/** Raisons renvoyées par les routes de qualité des agents. */
function qualityError(reason: string): string | null {
  switch (reason) {
    case 'not_enough_cases':
      return t('quality.error.notEnough')
    case 'already_running':
      return t('quality.error.running')
    case 'case_limit':
      return t('quality.error.caseLimit')
    case 'proposal_expired':
      return t('quality.error.expired')
    case 'agent_changed':
      return t('quality.error.agentChanged')
    case 'confidential':
      return t('quality.error.confidential')
    case 'unavailable':
      return t('quality.error.unavailable')
    case 'quota':
      return t('error.quota')
    case 'instructions_sensitive':
      return t('instructions.error.sensitive')
    case 'instructions_injection':
      return t('instructions.error.injection')
    case 'unknown_principal':
      return t('share.error.unknown')
    case 'sharing_limit':
      return t('share.error.limit')
    case 'skill_injection':
      return t('skills.error.injection')
    case 'skill_sensitive':
      return t('skills.error.sensitive')
    case 'skill_file_sensitive':
      return t('skills.error.fileSensitive')
    case 'skill_files_limit':
      return t('skills.error.filesLimit')
    case 'http_error':
    case 'timeout':
    case 'network':
    case 'protocol_error':
      return t('connectors.error.unreachable')
    case 'invalid_state':
      return t('connectors.error.state')
    case 'token_failed':
      return t('connectors.error.token_failed')
    case 'connect_required':
      return t('connectors.error.connectRequired')
    case 'invalid_url':
      return t('connectors.error.url')
    case 'already_added':
      return t('connectors.error.alreadyAdded')
    case 'oauth_discovery_failed':
      return t('connectors.error.discovery')
    case 'oauth_registration_required':
      return t('connectors.error.registration')
    case 'oauth_registration_failed':
      return t('connectors.error.registrationFailed')
    case 'tenant_required':
      return t('connectors.error.tenant')
    case 'token_required':
      return t('connectors.error.token')
    case 'skill_zip_invalid':
    case 'skill_zip_invalid_zip':
      return t('skills.error.zip')
    case 'skill_zip_too_large':
    case 'skill_zip_too_many_entries':
      return t('skills.error.zipTooLarge')
    case 'skill_zip_missing_skill_md':
      return t('skills.error.zipMissing')
    case 'skill_zip_invalid_skill_md':
      return t('skills.error.zipSkillMd')
    case 'presets_limit':
      return t('presets.limit')
    case 'local_only':
      return t('picker.localOnly')
    case 'not_enough_examples':
      return t('workshop.error.notEnough')
    case 'examples_limit':
      return t('workshop.error.limit')
    case 'not_deployable':
      return t('workshop.notDeployable')
    case 'decision_unavailable':
      return t('workshop.unavailable')
    case 'training_failed':
      return t('workshop.error.failed')
    case 'schedule_limit':
      return t('schedules.error.limit')
    case 'no_knowledge':
      return t('schedules.error.noKnowledge')
    default:
      return null
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
      // JSON seulement s'il y a un corps texte : le serveur refuse un corps JSON vide
      // (DELETE, POST sans données). Un fichier envoie son propre type.
      ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
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

/** Qualité d'un agent : score mesuré sur ses cas (aucun contenu). */
export type QualityScore = { passed: number; total: number; mean: number }
export type AgentVersion = { id: string; version: number; instructions: string; source: 'edit' | 'improvement' | 'restore'; score: QualityScore | null; createdAt: string }
export type AgentEvalCase = { id: string; status: 'proposed' | 'active'; origin: 'feedback' | 'manual'; question: string; comment: string | null; rubric: string | null; createdAt: string }
export type ImproveProgress = { phase: 'before' | 'proposal' | 'after'; done: number; total: number }
type Verdicts = Record<string, { passed: boolean; reason: string }>
export type ImproveResult = {
  kind: 'nothing_to_fix' | 'no_proposal' | 'rejected' | 'proposed'
  judge: string
  before: { score: QualityScore; cases: Verdicts }
  after?: { score: QualityScore; cases: Verdicts }
  /** Cas jamais montrés à l'optimiseur (dès 4 cas) : se généralise-t-elle ? */
  heldOut?: { before: { passed: number; total: number }; after: { passed: number; total: number } } | null
  proposalId?: string
  instructions?: string
  regressions?: string[]
}

/** Agent planifié (chaque jour, chaque semaine) ou déclenché (document ajouté à sa base). */
export type ScheduleRule = { cadence: 'daily'; hour: number } | { cadence: 'weekly'; hour: number; weekday: number }
export type AgentSchedule = {
  id: string
  agentId: string
  conversationId: string
  name: string
  prompt: string
  kind: 'schedule' | 'knowledge'
  rule: ScheduleRule | null
  timezone: string
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: 'done' | 'paused' | 'error' | 'skipped' | null
}
export type ScheduleInput = { agentId: string; name: string; prompt: string; kind: AgentSchedule['kind']; cadence?: 'daily' | 'weekly'; hour?: number; weekday?: number; timezone: string }

/** Atelier d'entraînement : exemples étiquetés et têtes de décision mesurées. */
export type Confusion = { tp: number; fn: number; tn: number; fp: number }
export type DecisionExample = { id: string; text: string; label: string; split: 'train' | 'test'; createdAt: string }
export type DecisionModel = {
  id: string
  version: number
  status: 'candidate' | 'active' | 'retired'
  deployable: boolean
  metrics: { candidate: Confusion; baseline: Confusion; baselineKind: 'zero_shot' | 'head'; baselineVersion: number | null; train: number; test: number }
  createdAt: string
}
export type Workshop = { available: boolean; labels: { positive: string; negative: string }; examples: DecisionExample[]; models: DecisionModel[] }

/** Amélioration (flux SSE) : progression, puis résultat. Interrompre : plus aucun appel facturé. */
async function improveStream(agentId: string, onProgress: (progress: ImproveProgress) => void, signal?: AbortSignal): Promise<ImproveResult> {
  const response = await send(`/agents/${agentId}/quality/improve`, { method: 'POST', body: '{}', ...(signal ? { signal } : {}) })
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
      if (event === 'progress') onProgress(payload as ImproveProgress)
      else if (event === 'result') return payload as ImproveResult
      else if (event === 'error') throw new Error(payload.reason === 'quota' ? t('error.quota') : t('quality.failed'))
    }
  }
  throw new Error(t('quality.failed'))
}

/** Action d'écriture en attente de ton accord : aperçu construit par le serveur. */
export type ToolApproval = {
  id: string
  title: string
  detail: string
  /** Un contenu lu pendant la réponse contenait des consignes adressées à l'assistant. */
  warning?: boolean
  /** Appel sortant d'une réponse qui a lu un contenu externe ET des données internes. */
  exposure?: boolean
  /** Demande faite par un sous-agent de l'équipe : son nom. */
  onBehalfOf?: string
}

/** Étape d'un agent pendant la réponse (appel d'outil). */
export type AgentStep = {
  id: string
  name: string
  /** denied : action refusée (par toi, ou faute de réponse). */
  status: 'running' | 'done' | 'error' | 'denied'
  summary?: string
  approval?: ToolApproval
  /** Étape d'un sous-agent : son nom, et l'étape de délégation qui l'a lancé. */
  agent?: string
  parent?: string
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

export type ActiveRun = RunSnapshot & { id: string; kind: 'message' | 'regenerate' | 'continue'; question: string }

/** Demande de validation reçue du serveur, rattachée à son étape. */
export const approvalStep = (payload: { id: unknown; stepId: unknown; tool: unknown; title: unknown; detail?: unknown; warning?: unknown; exposure?: unknown; onBehalfOf?: unknown }): AgentStep => ({
  id: String(payload.stepId),
  name: String(payload.tool),
  status: 'running',
  approval: { id: String(payload.id), title: String(payload.title), detail: String(payload.detail ?? ''), ...(payload.warning === true ? { warning: true } : {}), ...(payload.exposure === true ? { exposure: true } : {}), ...(typeof payload.onBehalfOf === 'string' ? { onBehalfOf: payload.onBehalfOf.slice(0, 60) } : {}) },
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
      settings?: ConversationSettings
      archived?: boolean
      tags?: string[]
    },
  ) =>
    (await request<{ conversation: ConversationSummary }>(`/conversations/${id}`, json('PATCH', changes))).conversation,

  /** Nouvelle conversation reprenant celle-ci jusqu'à ce message. */
  forkConversation: async (id: string, messageId: string) =>
    (await request<{ conversation: ConversationSummary }>(`/conversations/${id}/fork`, json('POST', { messageId }))).conversation,

  listSkills: async () => (await request<{ skills: Skill[] }>('/skills')).skills,
  createSkill: async (input: SkillInput) => (await request<{ skill: Skill }>('/skills', json('POST', input))).skill,
  updateSkill: async (id: string, input: SkillInput) => (await request<{ skill: Skill }>(`/skills/${id}`, json('PUT', input))).skill,
  deleteSkill: (id: string) => request<void>(`/skills/${id}`, { method: 'DELETE' }),
  uploadSkillFile: async (id: string, file: Blob, name: string) =>
    (
      await request<{ file: SkillFile }>(`/skills/${id}/files`, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
      })
    ).file,
  deleteSkillFile: (id: string, fileId: string) => request<void>(`/skills/${id}/files/${fileId}`, { method: 'DELETE' }),

  listFiles: async () => (await request<{ files: LibraryFile[] }>('/me/files')).files,
  /** Copie d'un fichier déjà envoyé, en attente dans cette conversation. */
  copyAttachment: async (conversationId: string, attachmentId: string) =>
    request<{ attachment: AttachmentMeta; sensitive?: boolean }>(`/conversations/${conversationId}/attachments/copy`, json('POST', { attachmentId })),
  deleteFile: (id: string) => request<void>(`/me/files/${id}`, { method: 'DELETE' }),

  listPresets: async () => (await request<{ presets: Preset[] }>('/me/presets')).presets,
  createPreset: async (name: string, settings: ConversationSettings) =>
    (await request<{ preset: Preset }>('/me/presets', json('POST', { name, settings }))).preset,
  deletePreset: (id: string) => request<void>(`/me/presets/${id}`, { method: 'DELETE' }),

  getMessages: async (id: string) => {
    const data = await request<Message[] | { messages: Message[] }>(`/conversations/${id}/messages`)
    return Array.isArray(data) ? data : data.messages
  },

  sendMessage: (
    id: string,
    input: { content: string; attachmentIds?: string[]; editMessageId?: string },
    options: StreamOptions = {},
  ) => stream<{ userMessage: Message; assistantMessage: Message }>(`/conversations/${id}/messages`, input, options),

  /** Régénérer ; avec un modèle : comparer (même question, autre modèle, nouvelle version). */
  regenerate: (id: string, options: StreamOptions = {}, model?: ModelSelection) =>
    stream<{ assistantMessage: Message }>(`/conversations/${id}/regenerate`, model ? { model } : {}, options),
  /** Reprend la dernière réponse inachevée là où elle s'arrête (même message). */
  continueAnswer: (id: string, options: StreamOptions = {}) =>
    stream<{ assistantMessage: Message }>(`/conversations/${id}/continue`, {}, options),

  /** Ta réponse à une demande de validation : la réponse reprend, diffusée comme un envoi. */
  decideApproval: (conversationId: string, approvalId: string, approved: boolean, options: StreamOptions = {}) =>
    stream<{ userMessage?: Message; assistantMessage?: Message }>(`/conversations/${conversationId}/approvals/${approvalId}`, { approved }, options),

  /** Réponse en cours dans la conversation (reconnexion), ou null. */
  listMemories: async () => (await request<{ memories: UserMemory[] }>('/me/memories')).memories,
  deleteMemory: (id: string) => request<void>(`/me/memories/${id}`, { method: 'DELETE' }),
  clearMemories: () => request<void>('/me/memories', { method: 'DELETE' }),

  sharingDirectory: () => request<SharingDirectory>('/sharing/directory'),
  getAccess: async (type: 'agent' | 'prompt' | 'skill', id: string) => (await request<{ grants: AccessGrant[] }>(`/${type}s/${id}/access`)).grants,
  setAccess: async (type: 'agent' | 'prompt' | 'skill', id: string, grants: AccessGrant[]) =>
    (await request<{ grants: AccessGrant[] }>(`/${type}s/${id}/access`, json('PUT', { grants }))).grants,
  listGroups: async () => (await request<{ groups: MemberGroup[] }>('/groups')).groups,
  createGroup: async (name: string) => (await request<{ group: MemberGroup }>('/groups', json('POST', { name }))).group,
  updateGroup: async (id: string, changes: { name?: string; memberIds?: string[] }) =>
    (await request<{ group: MemberGroup }>(`/groups/${id}`, json('PUT', changes))).group,
  deleteGroup: (id: string) => request<void>(`/groups/${id}`, { method: 'DELETE' }),

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

  /** Agents planifiés (chacun les siens). */
  listSchedules: async () => (await request<{ schedules: AgentSchedule[] }>('/me/schedules')).schedules,
  createSchedule: async (input: ScheduleInput) => (await request<{ schedule: AgentSchedule }>('/me/schedules', json('POST', input))).schedule,
  setScheduleEnabled: async (id: string, enabled: boolean) => (await request<{ schedule: AgentSchedule }>(`/me/schedules/${id}`, json('PATCH', { enabled }))).schedule,
  runSchedule: (id: string) => request<{ ok: true }>(`/me/schedules/${id}/run`, json('POST', {})),
  deleteSchedule: (id: string) => request<void>(`/me/schedules/${id}`, { method: 'DELETE' }),

  /** Atelier d'entraînement (administrateurs). */
  getWorkshop: () => request<Workshop>('/organization/decision/routing'),
  addDecisionExamples: async (examples: { text: string; label: string }[]) =>
    (await request<{ examples: DecisionExample[] }>('/organization/decision/routing/examples', json('POST', { examples }))).examples,
  deleteDecisionExample: (id: string) => request<void>(`/organization/decision/routing/examples/${id}`, { method: 'DELETE' }),
  trainDecision: async () => (await request<{ model: DecisionModel }>('/organization/decision/routing/train', json('POST', {}))).model,
  activateDecision: (id: string) => request<{ ok: true }>(`/organization/decision/routing/models/${id}/activate`, json('POST', {})),
  deactivateDecision: () => request<{ ok: true }>('/organization/decision/routing/deactivate', json('POST', {})),

  /** Qualité d'un agent (auteur ou administrateur) : versions, cas, amélioration mesurée. */
  getQuality: (agentId: string) => request<{ versions: AgentVersion[]; cases: AgentEvalCase[] }>(`/agents/${agentId}/quality`),
  addEvalCase: async (agentId: string, question: string, rubric: string) =>
    (await request<{ case: AgentEvalCase }>(`/agents/${agentId}/quality/cases`, json('POST', { question, rubric }))).case,
  activateEvalCase: async (agentId: string, caseId: string, rubric: string) =>
    (await request<{ case: AgentEvalCase }>(`/agents/${agentId}/quality/cases/${caseId}`, json('PUT', { rubric }))).case,
  deleteEvalCase: (agentId: string, caseId: string) => request<void>(`/agents/${agentId}/quality/cases/${caseId}`, { method: 'DELETE' }),
  improveAgent: improveStream,
  applyProposal: (agentId: string, proposalId: string) =>
    request<{ agent: { id: string; instructions: string }; version: AgentVersion | null }>(`/agents/${agentId}/quality/apply`, json('POST', { proposalId })),
  restoreVersion: (agentId: string, versionId: string) =>
    request<{ agent: { id: string; instructions: string }; version: AgentVersion | null }>(`/agents/${agentId}/quality/versions/${versionId}/restore`, json('POST', {})),

  /** 👍 / 👎 sur une réponse (null : retiré). */
  setFeedback: (conversationId: string, messageId: string, feedback: MessageFeedback | null, share = false) =>
    request<{ feedback: MessageFeedback | null; shared?: { ok: boolean; reason?: string } }>(
      `/conversations/${conversationId}/messages/${messageId}/feedback`,
      json('PUT', feedback ? { ...feedback, ...(share ? { share: true } : {}) } : { rating: null }),
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

  /** Voix locale disponible sur la plateforme (dictée, lecture). */
  audioCapabilities: () => request<{ dictation: boolean; speech: boolean }>('/audio/capabilities'),
  transcribe: async (audio: Blob, type: string, language: 'fr' | 'en') =>
    (
      await request<{ text: string }>(`/audio/transcriptions?language=${language}`, {
        method: 'POST',
        body: audio,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Type': type },
      })
    ).text,
  speak: async (text: string) => (await send('/audio/speech', json('POST', { text }))).blob(),

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
  mcpCatalog: async () => (await request<{ connectors: CatalogConnector[] }>('/mcp-catalog')).connectors,
  addCatalogConnector: async (id: string, input: { tenant?: string; token?: string; clientId?: string; clientSecret?: string }) =>
    (await request<{ server: McpServer }>(`/organization/mcp-catalog/${id}`, json('POST', input))).server,
  /** Import d'un dossier de compétence zippé (SKILL.md + références). */
  importSkill: async (file: Blob, confidential: boolean) =>
    request<{ skill: Skill; skipped: { name: string; reason: 'script' | 'unsupported' | 'unreadable' | 'limit' }[] }>(`/skills/import${confidential ? '?confidential=true' : ''}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  listMcpServers: async () => (await request<{ servers: McpServer[] }>('/organization/mcp-servers')).servers,
  listMcpConnections: async () => (await request<{ connections: McpConnection[] }>('/me/mcp-connections')).connections,
  /** Adresse du fournisseur OAuth où envoyer l'utilisateur. */
  connectMcp: async (id: string) => (await request<{ authorizationUrl: string }>(`/mcp-servers/${id}/connect`, json('POST', {}))).authorizationUrl,
  finishMcpConnection: (state: string, code: string) => request<{ serverId: string; name: string }>('/mcp/oauth/callback', json('POST', { state, code })),
  disconnectMcp: (id: string) => request<void>(`/mcp-servers/${id}/connection`, { method: 'DELETE' }),
  createMcpServer: async (input: { name: string; url: string; token?: string; oauth?: { clientId?: string; clientSecret?: string; scope?: string }; openapi?: { spec: Record<string, unknown> } }) =>
    (await request<{ server: McpServer }>('/organization/mcp-servers', json('POST', input))).server,
  discoverMcpTools: async (id: string) =>
    (await request<{ tools: McpDiscoveredTool[] }>(`/organization/mcp-servers/${id}/discover`, { method: 'POST' })).tools,
  approveMcpServer: async (id: string, tools: { name: string; access: 'read' | 'write'; fingerprint: string }[]) =>
    (await request<{ server: McpServer }>(`/organization/mcp-servers/${id}/approve`, json('POST', { tools }))).server,
  setMcpServerEnabled: async (id: string, enabled: boolean) =>
    (await request<{ server: McpServer }>(`/organization/mcp-servers/${id}`, json('PATCH', { enabled }))).server,
  deleteMcpServer: (id: string) => request<void>(`/organization/mcp-servers/${id}`, { method: 'DELETE' }),
}
