import type { Page, Route } from '@playwright/test'

// Faux backend pour les tests d'écran : chaque appel /api/… reçoit une réponse
// fictive cohérente. Toute route inconnue répond 404 et est notée : un test
// peut ainsi vérifier qu'aucun appel imprévu n'a eu lieu.

export type MockOptions = {
  role?: 'owner' | 'admin' | 'member' | 'reader'
  /** Outils installés sur la plateforme (le reste est « non installé »). */
  platformTools?: string[]
  /** Réponse de l'assistant au prochain message (texte Markdown). */
  answer?: string
  /** Agents de l'organisation. */
  agents?: unknown[]
  /** Conversation existante à deux versions : branche affichée, et celle obtenue en changeant de version. */
  branches?: { title: string; shown: unknown[]; other: unknown[] }
}

/** Agent fictif (profil complet, comme le renvoie l'API). */
export function fakeAgent(name: string, options: { mine?: boolean; tools?: string[]; color?: string; provider?: string; model?: string } = {}) {
  return {
    id: `agent-${name.toLowerCase().replace(/[^a-z]/g, '')}`,
    name,
    avatar: { kind: 'alien', color: options.color ?? 'sky', eyes: 'classic', accessory: 'none' },
    instructions: `Tu es ${name}.`,
    provider: options.provider ?? 'mistral',
    model: options.model ?? 'mistral-small-latest',
    tools: options.tools ?? ['search_knowledge'],
    mcpServers: [],
    createdBy: options.mine ? 'u-1' : 'u-2',
    canEdit: Boolean(options.mine),
  }
}

const now = '2026-10-17T08:00:00.000Z'
const ORG = '11111111-1111-4111-8111-111111111111'

export async function mockApi(page: Page, options: MockOptions = {}) {
  const role = options.role ?? 'admin'
  const unknown: string[] = []
  const conversations: { id: string; title: string; agentId: string | null; model: null; projectId: null; knowledge: { agent: boolean; project: boolean }; createdAt: string; updatedAt: string }[] = []
  const messages = new Map<string, { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }[]>()
  let counter = 0
  const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
  let branchShown = options.branches?.shown
  if (options.branches) {
    const conversationId = '00000000-0000-4000-8000-0000000000b1'
    conversations.push({ id: conversationId, title: options.branches.title, agentId: null, model: null, projectId: null, knowledge: { agent: true, project: true }, createdAt: now, updatedAt: now })
  }

  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/api/, '')
    const method = request.method()
    const key = `${method} ${path}`

    if (key === 'GET /auth/me') {
      return json(route, { user: { userId: 'u-1', organizationId: ORG, role }, profile: { name: 'Camille Test', email: 'camille@polaris.example' } })
    }
    if (key === 'GET /me/preferences') return json(route, { preferences: { locale: 'fr', sendOnEnter: true, reduceMotion: 'on' } })
    if (key === 'PUT /me/preferences') return json(route, { preferences: request.postDataJSON() })
    if (key === 'GET /conversations') return json(route, { conversations })
    if (key === 'GET /projects') return json(route, { projects: [] })
    if (key === 'GET /agents') return json(route, { agents: options.agents ?? [] })
    if (key === 'POST /agents') {
      const input = request.postDataJSON() as Record<string, unknown>
      return json(route, { agent: { ...input, id: id(), createdBy: 'u-1', canEdit: true } }, 201)
    }
    if (key === 'GET /models') {
      return json(route, { providers: [{ id: 'mistral', available: true, allowed: true, models: [{ id: 'mistral-small-latest', label: 'mistral-small' }] }], defaultModel: { provider: 'mistral', model: 'mistral-small-latest' } })
    }
    if (key === 'GET /usage') {
      return json(route, { usage: { period: '2026-10-01', total: { inputTokens: 1200, outputTokens: 300 }, byProvider: { mistral: { inputTokens: 1200, outputTokens: 300 } }, mine: { inputTokens: 800, outputTokens: 200 }, tools: { web: 42 } }, limits: { monthly: 100_000, providers: {}, tools: { web: 500 } } })
    }
    if (key === 'GET /organization') {
      return json(route, {
        organization: { id: ORG, name: 'Polaris', ...(role === 'owner' || role === 'admin' ? { sso: { alias: null, defaultRole: 'member' } } : {}) },
        settings: { allowedProviders: ['mistral'], monthlyTokenLimit: 100_000, providerTokenLimits: {}, embeddingProvider: null, linksEnabled: false, linkDomains: [], tools: ['search_knowledge', 'save_to_knowledge'], toolLimits: { web: 500 } },
        configuredProviders: ['mistral'],
        embeddingProviders: [],
        platformTools: options.platformTools ?? ['search_knowledge', 'save_to_knowledge'],
      })
    }
    if (key === 'GET /organization/members') {
      return json(route, { members: [{ userId: 'u-1', email: 'camille@polaris.example', role, joinedAt: now, monthlyTokens: 1000 }], invitations: [] })
    }
    if (key === 'GET /organization/mcp-servers') return json(route, { servers: [] })
    if (key === 'POST /conversations') {
      const body = (request.postDataJSON() ?? {}) as { agentId?: string }
      const conversation = { id: id(), title: 'Nouvelle conversation', agentId: body.agentId ?? null, model: null, projectId: null, knowledge: { agent: true, project: true }, createdAt: now, updatedAt: now }
      conversations.unshift(conversation)
      messages.set(conversation.id, [])
      return json(route, { conversation }, 201)
    }
    const conversationPath = /^\/conversations\/([^/]+)(\/.*)?$/.exec(path)
    if (conversationPath) {
      const [, conversationId, rest = ''] = conversationPath
      if (options.branches && method === 'GET' && rest === '/messages') return json(route, { messages: branchShown })
      if (options.branches && method === 'POST' && rest === '/branch') {
        branchShown = branchShown === options.branches.shown ? options.branches.other : options.branches.shown
        return json(route, { messages: branchShown })
      }
      if (method === 'GET' && rest === '/messages') return json(route, { messages: messages.get(conversationId!) ?? [] })
      if (method === 'GET' && rest === '/files') return json(route, { files: [] })
      if (method === 'GET' && rest === '/run') return json(route, { run: null })
      if (method === 'PATCH' && rest === '') return json(route, { conversation: conversations.find((item) => item.id === conversationId) })
      if (method === 'POST' && rest === '/messages') {
        // Réponse en flux (SSE), comme le vrai serveur : jetons, puis « done ».
        const content = String((request.postDataJSON() as { content: string }).content)
        const answer = options.answer ?? 'Bonjour !'
        const userMessage = { id: id(), role: 'user' as const, content, createdAt: now }
        const assistantMessage = { id: id(), role: 'assistant' as const, content: answer, createdAt: now }
        messages.get(conversationId!)?.push(userMessage, assistantMessage)
        const chunks = answer.match(/[\s\S]{1,40}/g) ?? []
        const body = [...chunks.map((text) => `event: token\ndata: ${JSON.stringify({ text })}\n\n`), `event: done\ndata: ${JSON.stringify({ userMessage, assistantMessage })}\n\n`].join('')
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
      }
    }
    unknown.push(key)
    return json(route, { error: 'Not found' }, 404)
  })

  return { unknown }
}
