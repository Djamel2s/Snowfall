import keycloak from '../auth/keycloak'

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export type ConversationSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!keycloak.authenticated) {
    throw new Error('Session expirée. Reconnectez-vous.')
  }

  await keycloak.updateToken(30)

  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${keycloak.token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Accès refusé ou session expirée.')
    }
    if (response.status === 404) {
      throw new Error('Conversation introuvable.')
    }
    throw new Error(`Erreur serveur (${response.status}).`)
  }

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

  createConversation: async (title?: string) => {
    const data = await request<
      ConversationSummary | { conversation: ConversationSummary }
    >('/conversations', {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    })

    return 'conversation' in data ? data.conversation : data
  },

  getMessages: async (id: string) => {
    const data = await request<
      Message[] | { messages: Message[] }
    >(`/conversations/${id}/messages`)

    return Array.isArray(data) ? data : data.messages
  },

  sendMessage: async (id: string, content: string) =>
    request<{
      response: string
      userMessage: Message
      assistantMessage: Message
    }>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  deleteConversation: (id: string) =>
    request<void>(`/conversations/${id}`, { method: 'DELETE' }),
}
