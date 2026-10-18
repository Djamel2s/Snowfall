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
  /**
   * Écriture à valider : le prochain message s'arrête sur une demande de
   * validation. waiting : une conversation existante a déjà une réponse en pause
   * (reconnexion).
   */
  approval?: { waiting?: boolean; warning?: boolean; exposure?: boolean }
}

const APPROVAL = { id: 'a-1', stepId: 's-1', tool: 'save_to_knowledge', title: 'Enregistrer une note', detail: 'Wifi invités : Snowfall-Guest' }
const sse = (events: [string, unknown][]) => events.map(([event, data]) => `event: ${event}
data: ${JSON.stringify(data)}

`).join('')

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
  const feedbackCalls: { messageId: string; rating: 'up' | 'down' | null; comment?: string }[] = []
  const conversations: { id: string; title: string; agentId: string | null; model: null; projectId: null; knowledge: { agent: boolean; project: boolean }; createdAt: string; updatedAt: string }[] = []
  const messages = new Map<string, { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }[]>()
  let counter = 0
  const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
  let branchShown = options.branches?.shown
  let prompts = [{ id: 'p-shared', name: 'Résumé', content: 'Résume ce texte en 3 points.', shared: true, mine: false, updatedAt: now }]
  const temporaryIds = new Set<string>()
  let pendingQuestion: string | null = null
  let memories = [
    { id: 'm-1', content: 'Préfère des réponses en anglais', createdAt: now },
    { id: 'm-2', content: 'Travaille sur le dossier Orion', createdAt: now },
  ]
  let sharesById: { id: string; token: string; expiresAt: string; title: string; messages: unknown[] }[] = []
  const decisions: { approvalId: string; approved: boolean }[] = []
  let cancels = 0
  // Réponse en pause côté serveur (reconnexion), jusqu'à la décision ou l'arrêt.
  let waitingRun: { conversationId: string; question: string } | null = null
  if (options.approval?.waiting) {
    const conversationId = '00000000-0000-4000-8000-0000000000a1'
    conversations.push({ id: conversationId, title: 'Note wifi', agentId: null, model: null, projectId: null, knowledge: { agent: true, project: true }, createdAt: now, updatedAt: now })
    messages.set(conversationId, [])
    waitingRun = { conversationId, question: 'Retiens le wifi invités.' }
  }
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
    if (key === 'GET /me/preferences') return json(route, { preferences: { locale: 'fr', sendOnEnter: true, reduceMotion: 'on', memory: false } })
    // Mémoire : deux faits retenus.
    if (key === 'GET /me/memories') return json(route, { memories })
    if (key === 'DELETE /me/memories') {
      memories = []
      return route.fulfill({ status: 204 })
    }
    const memoryPath = /^\/me\/memories\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && memoryPath) {
      memories = memories.filter((item) => item.id !== memoryPath[1])
      return route.fulfill({ status: 204 })
    }
    if (key === 'PUT /me/preferences') return json(route, { preferences: request.postDataJSON() })
    if (key === 'GET /conversations') return json(route, { conversations })
    if (key === 'GET /projects') return json(route, { projects: [] })
    if (key === 'GET /agents') return json(route, { agents: options.agents ?? [] })
    const agentPath = /^\/agents\/([^/]+)$/.exec(path)
    if (method === 'PUT' && agentPath) {
      const input = request.postDataJSON() as Record<string, unknown>
      return json(route, { agent: { ...input, id: agentPath[1], createdBy: 'u-1', canEdit: true } })
    }
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
      const body = (request.postDataJSON() ?? {}) as { agentId?: string; temporary?: boolean }
      const conversation = { id: id(), title: 'Nouvelle conversation', agentId: body.agentId ?? null, model: null, projectId: null, knowledge: { agent: true, project: true }, createdAt: now, updatedAt: now }
      messages.set(conversation.id, [])
      // Comme le serveur : une temporaire n'apparaît jamais dans l'historique.
      if (body.temporary) {
        temporaryIds.add(conversation.id)
        return json(route, { conversation: { ...conversation, temporary: true } }, 201)
      }
      conversations.unshift(conversation)
      return json(route, { conversation }, 201)
    }
    if (key === 'POST /conversations/import') {
      conversations.unshift({ id: id(), title: 'Voyage importé', agentId: null, model: null, projectId: null, knowledge: { agent: true, project: true }, createdAt: now, updatedAt: now })
      return json(route, { imported: 1, skipped: 0, format: 'chatgpt' }, 201)
    }
    // Bibliothèque de prompts (un prompt partagé par une collègue au départ).
    if (key === 'GET /prompts') return json(route, { prompts })
    if (key === 'POST /prompts') {
      const body = request.postDataJSON() as { name: string; content: string; shared: boolean }
      const prompt = { id: id(), ...body, mine: true, updatedAt: now }
      prompts.unshift(prompt)
      return json(route, { prompt }, 201)
    }
    const promptPath = /^\/prompts\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && promptPath) {
      prompts = prompts.filter((item) => item.id !== promptPath[1])
      return route.fulfill({ status: 204 })
    }
    if (key === 'GET /me/export') return json(route, { format: 'snowfall.personal-data', version: 1, conversations: [] })
    // Partages : un seul lien fictif, ouvert par son jeton.
    if (key === 'POST /shares/open') {
      const { token } = request.postDataJSON() as { token: string }
      const share = sharesById.find((item) => item.token === token)
      if (!share) return json(route, { error: 'Not found' }, 404)
      return json(route, { share: { id: share.id, title: share.title, expiresAt: share.expiresAt, createdAt: now, mine: false, snapshot: { messages: share.messages } } })
    }
    const deleteShare = /^\/shares\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && deleteShare) {
      sharesById = sharesById.filter((item) => item.id !== deleteShare[1])
      return route.fulfill({ status: 204 })
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
      const feedbackPath = /^\/messages\/([^/]+)\/feedback$/.exec(rest)
      if (method === 'PUT' && feedbackPath) {
        const body = request.postDataJSON() as { rating: 'up' | 'down' | null; comment?: string }
        feedbackCalls.push({ messageId: feedbackPath[1]!, ...body })
        return json(route, { feedback: body.rating ? body : null })
      }
      if (method === 'GET' && rest === '/files') return json(route, { files: [] })
      if (method === 'GET' && rest === '/shares') return json(route, { shares: sharesById.map(({ id, token, expiresAt }) => ({ id, token, expiresAt, createdAt: now })) })
      if (method === 'POST' && rest === '/shares') {
        const { days } = request.postDataJSON() as { days: number }
        const conversation = conversations.find((item) => item.id === conversationId)!
        const share = { id: id(), token: 'T'.repeat(43), expiresAt: new Date(Date.parse(now) + days * 86_400_000).toISOString(), title: conversation.title, messages: messages.get(conversationId!) ?? [] }
        sharesById.push(share)
        return json(route, { share: { id: share.id, token: share.token, expiresAt: share.expiresAt, createdAt: now } }, 201)
      }
      if (method === 'GET' && rest === '/run') {
        if (waitingRun?.conversationId !== conversationId) return json(route, { run: null })
        return json(route, {
          run: {
            id: 'r-1',
            kind: 'message',
            question: waitingRun.question,
            status: 'waiting',
            text: "Je l'enregistre. ",
            steps: [{ id: APPROVAL.stepId, name: APPROVAL.tool, status: 'running' }],
            approvals: [APPROVAL],
          },
        })
      }
      if (method === 'POST' && rest === '/run/cancel') {
        cancels += 1
        waitingRun = null
        return route.fulfill({ status: 204 })
      }
      const approvalPath = /^\/approvals\/([^/]+)$/.exec(rest ?? '')
      if (method === 'POST' && approvalPath) {
        const { approved } = request.postDataJSON() as { approved: boolean }
        decisions.push({ approvalId: approvalPath[1]!, approved })
        const question = waitingRun?.question ?? pendingQuestion ?? ''
        waitingRun = null
        const answer = approved ? "Je l'enregistre. C'est noté." : "Je l'enregistre. Je n'enregistre rien."
        const userMessage = { id: id(), role: 'user' as const, content: question, createdAt: now }
        const assistantMessage = { id: id(), role: 'assistant' as const, content: answer, createdAt: now }
        messages.get(conversationId!)?.push(userMessage, assistantMessage)
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sse([
            ['step', { id: APPROVAL.stepId, name: APPROVAL.tool, status: approved ? 'done' : 'denied' }],
            ['token', { text: approved ? "C'est noté." : "Je n'enregistre rien." }],
            ['done', { userMessage, assistantMessage }],
          ]),
        })
      }
      if (method === 'DELETE' && rest === '') {
        const index = conversations.findIndex((item) => item.id === conversationId)
        if (index !== -1) conversations.splice(index, 1)
        temporaryIds.delete(conversationId!)
        return route.fulfill({ status: 204 })
      }
      if (method === 'PATCH' && rest === '') return json(route, { conversation: conversations.find((item) => item.id === conversationId) })
      if (method === 'POST' && rest === '/messages') {
        // Réponse en flux (SSE), comme le vrai serveur : jetons, puis « done ».
        const content = String((request.postDataJSON() as { content: string }).content)
        if (options.approval) {
          // Écriture demandée : la réponse s'arrête sur la validation.
          pendingQuestion = content
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: sse([
              ['token', { text: "Je l'enregistre. " }],
              ['step', { id: APPROVAL.stepId, name: APPROVAL.tool, status: 'running' }],
              ['approval', { ...APPROVAL, ...(options.approval.warning ? { warning: true } : {}), ...(options.approval.exposure ? { exposure: true, title: 'Envoyer une recherche sur le web', detail: 'verification 7731-ZETA' } : {}) }],
              ['paused', {}],
            ]),
          })
        }
        const answer = options.answer ?? 'Bonjour !'
        const userMessage = { id: id(), role: 'user' as const, content, createdAt: now }
        const assistantMessage = { id: id(), role: 'assistant' as const, content: answer, createdAt: now }
        messages.get(conversationId!)?.push(userMessage, assistantMessage)
        // Comme le serveur : le premier message donne son titre à la conversation.
        const conversation = conversations.find((item) => item.id === conversationId)
        if (conversation && conversation.title === 'Nouvelle conversation') conversation.title = content.slice(0, 80)
        const chunks = answer.match(/[\s\S]{1,40}/g) ?? []
        const body = [...chunks.map((text) => `event: token\ndata: ${JSON.stringify({ text })}\n\n`), `event: done\ndata: ${JSON.stringify({ userMessage, assistantMessage })}\n\n`].join('')
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
      }
    }
    unknown.push(key)
    return json(route, { error: 'Not found' }, 404)
  })

  return { unknown, feedbackCalls, decisions, cancels: () => cancels }
}
