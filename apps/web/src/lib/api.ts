import { login } from '../auth/session'

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export type ConversationSummary = {
  id: string
  title: string
  agentId: string | null
  createdAt: string
  updatedAt: string
}

export type ProviderId = 'mistral' | 'openai' | 'anthropic' | 'google' | 'local'

export type ProviderCatalog = {
  id: ProviderId
  available: boolean
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

async function send(path: string, init: RequestInit = {}) {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (!response.ok) {
    if (response.status === 401) {
      login()
      throw new Error('Session expirée. Redirection vers la connexion…')
    }
    if (response.status === 403) {
      throw new Error('Accès refusé.')
    }
    if (response.status === 429) {
      throw new Error('Trop de requêtes. Réessaie dans un instant.')
    }
    if (response.status === 404) {
      throw new Error('Conversation introuvable.')
    }
    throw new Error(`Erreur serveur (${response.status}).`)
  }

  return response
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await send(path, init)

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export const api = {
  listConversations: async () => {
    const data = await request<
      ConversationSummary[] | { conversations: ConversationSummary[] }
    >('/conversations')

    return Array.isArray(data) ? data : data.conversations
  },

  createConversation: async (options: { title?: string; agentId?: string } = {}) => {
    const data = await request<
      ConversationSummary | { conversation: ConversationSummary }
    >('/conversations', {
      method: 'POST',
      body: JSON.stringify(options),
    })

    return 'conversation' in data ? data.conversation : data
  },

  getMessages: async (id: string) => {
    const data = await request<
      Message[] | { messages: Message[] }
    >(`/conversations/${id}/messages`)

    return Array.isArray(data) ? data : data.messages
  },

  // Réponse en Server-Sent Events : onToken reçoit chaque fragment, la
  // promesse se résout avec les deux messages une fois enregistrés.
  sendMessage: async (
    id: string,
    content: string,
    options: { onToken?: (text: string) => void; signal?: AbortSignal } = {},
  ) => {
    const response = await send(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
      ...(options.signal ? { signal: options.signal } : {}),
    })

    if (!response.body) throw new Error('Réponse vide du serveur.')

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
          return payload as { userMessage: Message; assistantMessage: Message }
        } else if (event === 'error') {
          throw new Error(
            payload.error === 'Not found'
              ? 'Conversation introuvable.'
              : payload.error === 'Refused'
                ? 'Le modèle a décliné cette demande.'
                : payload.error === 'Provider unavailable'
                  ? 'Ce fournisseur n’est pas configuré.'
                  : 'L’assistant est indisponible. Réessaie dans un instant.',
          )
        }
      }
    }

    throw new Error('La réponse a été interrompue.')
  },

  deleteConversation: (id: string) =>
    request<void>(`/conversations/${id}`, { method: 'DELETE' }),

  listModels: async () =>
    (await request<{ providers: ProviderCatalog[] }>('/models')).providers,

  listAgents: async () =>
    (await request<{ agents: Agent[] }>('/agents')).agents,

  saveAgent: async (input: AgentInput, id?: string) =>
    (
      await request<{ agent: Agent }>(id ? `/agents/${id}` : '/agents', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(input),
      })
    ).agent,

  deleteAgent: (id: string) =>
    request<void>(`/agents/${id}`, { method: 'DELETE' }),
}
