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

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  attachments?: AttachmentMeta[]
}

export type ConversationSummary = {
  id: string
  title: string
  agentId: string | null
  /** Modèle choisi pour une conversation sans agent (null : modèle par défaut). */
  model: ModelSelection | null
  projectId: string | null
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

export type AgentInput = {
  name: string
  avatar: AgentAvatarData
  instructions: string
  provider: ProviderId
  model: string
}

export type Agent = AgentInput & {
  id: string
  createdBy: string | null
  canEdit: boolean
}

export type Role = 'owner' | 'admin' | 'member' | 'reader'

export type Preferences = {
  locale: 'fr' | 'en' | null
  sendOnEnter: boolean
  reduceMotion: 'system' | 'on' | 'off'
}

export type UsageTotals = { inputTokens: number; outputTokens: number }

export type Usage = {
  usage: {
    period: string
    total: UsageTotals
    byProvider: Partial<Record<ProviderId | 'echo', UsageTotals>>
    mine: UsageTotals
  }
  limits: { monthly: number | null; providers: Partial<Record<ProviderId, number>> }
}

export type OrganizationSettings = {
  allowedProviders: ProviderId[]
  monthlyTokenLimit: number | null
  providerTokenLimits: Partial<Record<ProviderId, number>>
}

export type Organization = {
  organization: { id: string; name: string; sso?: { alias: string | null; defaultRole: 'member' | 'reader' } }
  settings: OrganizationSettings
  configuredProviders: ProviderId[]
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
  if (body.reason === 'provider_quota_exceeded') return t('error.providerQuota')
  if (body.reason === 'quota_exceeded') return t('error.quota')
  if (body.error === 'Provider not allowed') return t('error.providerNotAllowed')
  if (body.error === 'Unsupported file') return t('error.unsupportedFile')
  if (body.error === 'Unreadable document') return t('error.unreadableFile')
  if (body.error === 'Too many attachments') return t('error.tooManyFiles')
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

type StreamOptions = { onToken?: (text: string) => void; signal?: AbortSignal }

/** Réponse en Server-Sent Events : onToken reçoit chaque fragment. */
async function stream<T>(path: string, body: unknown, options: StreamOptions): Promise<T> {
  const response = await send(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
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

      if (event === 'token') {
        options.onToken?.(payload.text as string)
      } else if (event === 'done') {
        return payload as T
      } else if (event === 'error') {
        throw new Error(
          payload.error === 'Not found'
            ? t('error.notFound')
            : payload.error === 'Refused'
              ? t('error.refused')
              : payload.error === 'Provider unavailable'
                ? t('error.providerUnavailable')
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
    options: { title?: string; agentId?: string; projectId?: string; model?: ModelSelection } = {},
  ) => {
    const data = await request<ConversationSummary | { conversation: ConversationSummary }>(
      '/conversations',
      json('POST', options),
    )
    return 'conversation' in data ? data.conversation : data
  },

  updateConversation: async (
    id: string,
    changes: { title?: string; projectId?: string | null; agentId?: string | null; model?: ModelSelection | null },
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
}
