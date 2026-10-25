import { CONNECTOR_CATALOG } from '../../api/src/mcp/catalog'
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
  approval?: { waiting?: boolean; warning?: boolean; exposure?: boolean; team?: boolean }
  /** Voix locale installée (dictée et lecture). */
  voice?: boolean
  /** Outils activés par l'organisation (défaut : base de connaissances). */
  orgTools?: string[]
  /** Un serveur MCP en mode OAuth (connexion personnelle). */
  mcpOAuth?: boolean
  /** Donnée sensible dans le message : bascule en local, ou refus (aucun modèle local). */
  sensitive?: 'local' | 'blocked'
  /** Thème des préférences (défaut : sombre). */
  theme?: 'system' | 'dark' | 'light'
  /** Réponse coupée (marquée inachevée) ; ce texte est la suite renvoyée par « continuer ». */
  continuation?: string
  /** Réponse du modèle comparé (régénération). */
  compareAnswer?: string
  /** « Mes fichiers » : fichiers déjà envoyés. */
  files?: { id: string; name: string; kind: 'document' | 'image'; mediaType: string; size: number; messageId: string; createdAt: string; conversationId: string }[]
  /** Préréglages déjà enregistrés. */
  presets?: { id: string; name: string; settings: Record<string, unknown>; createdAt: string }[]
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
    canShare: Boolean(options.mine),
  }
}

const now = '2026-10-17T08:00:00.000Z'
const ORG = '11111111-1111-4111-8111-111111111111'

export async function mockApi(page: Page, options: MockOptions = {}) {
  const role = options.role ?? 'admin'
  const unknown: string[] = []
  const feedbackCalls: { messageId: string; rating: 'up' | 'down' | null; comment?: string; share?: boolean }[] = []
  // Qualité des agents : un cas proposé (partagé par un collègue), puis ceux qu'on ajoute.
  const qualityCases: { id: string; status: 'proposed' | 'active'; origin: 'feedback' | 'manual'; question: string; comment: string | null; rubric: string | null; createdAt: string }[] = [
    { id: 'case-1', status: 'proposed', origin: 'feedback', question: 'Combien de jours de congés ?', comment: 'Il manque la source.', rubric: null, createdAt: '2026-10-17T08:00:00.000Z' },
  ]
  const qualityVersions: { id: string; version: number; instructions: string; source: string; score: { passed: number; total: number; mean: number } | null; createdAt: string }[] = [
    { id: 'v-1', version: 1, instructions: 'Tu es Juriste.', source: 'edit', score: null, createdAt: '2026-10-17T08:00:00.000Z' },
  ]
  const appliedProposals: string[] = []
  // Atelier : exemples (un sur trois en test), modèles entraînés.
  const decisionExamples: { id: string; text: string; label: string; split: 'train' | 'test'; createdAt: string }[] = []
  const decisionModels: { id: string; version: number; status: string; deployable: boolean; metrics: unknown; createdAt: string }[] = []
  const decisionCalls: string[] = []
  const schedules: Record<string, unknown>[] = []
  const scheduleRuns: string[] = []
  const savedPreferences: { theme?: string; instructions?: string }[] = []
  const conversationPatches: Record<string, unknown>[] = []
  const continueCalls: string[] = []
  const forks: { from: string; to: string }[] = []
  const skills: { id: string; name: string; description: string; instructions: string; confidential: boolean; version: number; mine: boolean; canEdit: boolean; shared: boolean; files: { id: string; name: string; mediaType: string; size: number; createdAt: string }[]; updatedAt: string }[] = []
  const agentSaves: Record<string, unknown>[] = []
  const catalogAdds: Record<string, unknown>[] = []
  const emptyJsonBodies: string[] = []
  const library = [...(options.files ?? [])]
  const copies: string[] = []
  const regenerateCalls: { model?: { provider: string; model: string } }[] = []
  const branchCalls: string[] = []
  const versions = new Map<string, Record<string, unknown> & { id: string }>()
  const presets: { id: string; name: string; settings: Record<string, unknown>; createdAt: string }[] = [...(options.presets ?? [])]
  const conversations: { id: string; title: string; agentId: string | null; model: null; projectId: null; knowledge: { agent: boolean; project: boolean }; createdAt: string; updatedAt: string }[] = []
  const messages = new Map<string, { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }[]>()
  let counter = 0
  const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
  let branchShown = options.branches?.shown
  let prompts = [{ id: 'p-shared', name: 'Résumé', content: 'Résume ce texte en 3 points.', shared: false, mine: false, canEdit: false, updatedAt: now }]
  // Droits fins : autorisations par ressource, groupes, annuaire.
  const access = new Map<string, unknown[]>()
  const accessCalls: { type: string; id: string; grants: unknown[] }[] = []
  const groups: { id: string; name: string; memberIds: string[] }[] = []
  const directory = [
    { userId: 'u-1', email: 'camille@polaris.example' },
    { userId: 'u-2', email: 'sami@polaris.example' },
    { userId: 'u-3', email: 'lea@polaris.example' },
  ]
  const temporaryIds = new Set<string>()
  // Connexions OAuth de l'utilisateur, par serveur (comme l'API : un administrateur
  // peut se connecter à un serveur encore en attente pour en choisir les outils).
  const mcpConnected = new Set<string>()
  let mcpConnecting = 'mcp-1'
  const approveCalls: { id: string; tools: { name: string; access: string }[] }[] = []
  const audioCalls: { type: string; size: number }[] = []
  const speechCalls: string[] = []
  type MockServer = { id: string; name: string; status: string; auth: string; kind: string; url: string; hasToken?: boolean; catalogId?: string; tools: { name: string; title: string | null; access: string }[] }
  const mcpServers: MockServer[] = options.mcpOAuth
    ? [{ id: 'mcp-1', name: 'Jira', status: 'approved', auth: 'oauth', kind: 'mcp', url: 'https://mcp.atlassian.com/v2/mcp', catalogId: 'atlassian', tools: [{ name: 'search_issues', title: null, access: 'read' }] }]
    : []
  const createdConnectors: unknown[] = []
  const savedSettings: Record<string, unknown>[] = []
  const oauthCallbacks: { state: string; code: string }[] = []
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

    // Comme Fastify : un corps JSON annoncé mais vide est refusé (400). Sans ce
    // contrôle, un DELETE ou un POST sans données passait ici et échouait en vrai.
    const declared = (request.headers()['content-type'] ?? '').startsWith('application/json')
    if (declared && !request.postData()) {
      emptyJsonBodies.push(key)
      return json(route, { error: "Body cannot be empty when content-type is set to 'application/json'" }, 400)
    }

    if (key === 'GET /auth/me') {
      return json(route, { user: { userId: 'u-1', organizationId: ORG, role }, profile: { name: 'Camille Test', email: 'camille@polaris.example' } })
    }
    if (key === 'GET /me/preferences') return json(route, { preferences: { locale: 'fr', sendOnEnter: true, reduceMotion: 'on', memory: false, theme: options.theme ?? 'dark', instructions: '' } })
    // Connexions personnelles (OAuth) : le « fournisseur » renvoie aussitôt sur /mcp/callback.
    if (key === 'GET /me/mcp-connections') {
      const visible = mcpServers.filter((server) => server.auth === 'oauth' && (server.status === 'approved' || (role === 'admin' && server.status === 'pending')))
      return json(route, { connections: visible.map((server) => ({ id: server.id, name: server.name, status: server.status, connected: mcpConnected.has(server.id) })) })
    }
    const connectPath = /^\/mcp-servers\/([^/]+)\/(connect|connection)$/.exec(path)
    if (connectPath && method === 'POST' && connectPath[2] === 'connect') {
      mcpConnecting = connectPath[1]!
      return json(route, { authorizationUrl: `${url.origin}/mcp/callback?state=${'S'.repeat(43)}&code=code-42` })
    }
    if (connectPath && method === 'DELETE' && connectPath[2] === 'connection') {
      mcpConnected.delete(connectPath[1]!)
      return route.fulfill({ status: 204 })
    }
    if (key === 'POST /mcp/oauth/callback') {
      oauthCallbacks.push(request.postDataJSON() as { state: string; code: string })
      mcpConnected.add(mcpConnecting)
      const server = mcpServers.find((item) => item.id === mcpConnecting)
      return json(route, { serverId: mcpConnecting, name: server?.name ?? 'Jira' })
    }
    if (key === 'GET /audio/capabilities') return json(route, { dictation: Boolean(options.voice), speech: Boolean(options.voice) })
    if (key === 'POST /audio/transcriptions') {
      audioCalls.push({ type: String(request.headers()['x-audio-type']), size: request.postDataBuffer()?.length ?? 0 })
      return json(route, { text: 'Combien de jours de congés ?' })
    }
    if (key === 'POST /audio/speech') {
      speechCalls.push((request.postDataJSON() as { text: string }).text)
      return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]) })
    }
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
    if (key === 'PUT /me/preferences') {
      const next = request.postDataJSON()
      // Comme l'API : une donnée de santé dans les instructions est refusée.
      if (/diabétique/i.test(next.instructions ?? '')) return json(route, { error: 'Invalid preferences', reason: 'instructions_sensitive' }, 400)
      savedPreferences.push(next)
      return json(route, { preferences: next })
    }
    if (key === 'GET /conversations') return json(route, { conversations })
    if (key === 'GET /projects') return json(route, { projects: [] })
    if (key === 'GET /agents') return json(route, { agents: options.agents ?? [] })
    if (method === 'GET' && /^\/agents\/[^/]+\/knowledge$/.test(path)) {
      return json(route, { knowledge: { id: null, confidential: false, canManage: true, embeddingModel: null, linksEnabled: false, sources: [] } })
    }
    if (key === 'GET /me/schedules') return json(route, { schedules })
    if (key === 'POST /me/schedules') {
      const body = request.postDataJSON() as Record<string, unknown>
      const schedule = { ...body, id: id(), conversationId: id(), rule: body.kind === 'schedule' ? { cadence: body.cadence, hour: body.hour, ...(body.weekday !== undefined ? { weekday: body.weekday } : {}) } : null, enabled: true, nextRunAt: body.kind === 'schedule' ? '2026-10-26T08:00:00.000Z' : null, lastRunAt: null, lastStatus: null }
      schedules.push(schedule)
      return json(route, { schedule }, 201)
    }
    const schedulePath = /^\/me\/schedules\/([^/]+)(\/run)?$/.exec(path)
    if (schedulePath && method === 'POST' && schedulePath[2]) {
      scheduleRuns.push(schedulePath[1]!)
      return json(route, { ok: true }, 202)
    }
    if (schedulePath && method === 'PATCH') {
      const schedule = schedules.find((item) => item.id === schedulePath[1])!
      Object.assign(schedule, request.postDataJSON() as Record<string, unknown>)
      return json(route, { schedule })
    }
    if (schedulePath && method === 'DELETE') {
      schedules.splice(schedules.findIndex((item) => item.id === schedulePath[1]), 1)
      return route.fulfill({ status: 204 })
    }
    if (path.startsWith('/organization/decision/routing')) {
      const sub = path.slice('/organization/decision/routing'.length)
      decisionCalls.push(`${method} ${sub || '/'}`)
      if (method === 'GET' && sub === '') return json(route, { available: true, labels: { positive: 'complexe', negative: 'simple' }, examples: [...decisionExamples].reverse(), models: [...decisionModels].reverse() })
      if (method === 'POST' && sub === '/examples') {
        const body = request.postDataJSON() as { examples: { text: string; label: string }[] }
        const created = body.examples.map((item) => ({ ...item, id: id(), split: (decisionExamples.length % 3 === 2 ? 'test' : 'train') as 'train' | 'test', createdAt: now }))
        for (const item of created) decisionExamples.push({ ...item, split: decisionExamples.length % 3 === 2 ? 'test' : 'train' })
        return json(route, { examples: created }, 201)
      }
      if (method === 'POST' && sub === '/train') {
        const model = { id: id(), version: decisionModels.length + 1, status: 'candidate', deployable: true, metrics: { candidate: { tp: 12, fn: 0, tn: 12, fp: 0 }, baseline: { tp: 10, fn: 2, tn: 12, fp: 0 }, baselineKind: 'zero_shot', baselineVersion: null, train: 40, test: 24 }, createdAt: now }
        decisionModels.push(model)
        return json(route, { model })
      }
      const activate = /^\/models\/([^/]+)\/activate$/.exec(sub)
      if (method === 'POST' && activate) {
        for (const model of decisionModels) if (model.status === 'active') model.status = 'retired'
        decisionModels.find((model) => model.id === activate[1])!.status = 'active'
        return json(route, { ok: true })
      }
    }
    const qualityPath = /^\/agents\/([^/]+)\/quality(\/.*)?$/.exec(path)
    if (qualityPath) {
      const sub = qualityPath[2] ?? ''
      if (method === 'GET' && sub === '') return json(route, { versions: [...qualityVersions].reverse(), cases: qualityCases })
      if (method === 'POST' && sub === '/cases') {
        const body = request.postDataJSON() as { question: string; rubric: string }
        const created = { id: id(), status: 'active' as const, origin: 'manual' as const, question: body.question, comment: null, rubric: body.rubric, createdAt: now }
        qualityCases.unshift(created)
        return json(route, { case: created }, 201)
      }
      const casePath = /^\/cases\/([^/]+)$/.exec(sub)
      if (method === 'PUT' && casePath) {
        const item = qualityCases.find((entry) => entry.id === casePath[1])!
        Object.assign(item, { status: 'active', rubric: (request.postDataJSON() as { rubric: string }).rubric })
        return json(route, { case: item })
      }
      if (method === 'POST' && sub === '/improve') {
        const total = qualityCases.filter((item) => item.status === 'active').length
        const cases = Object.fromEntries(qualityCases.map((item) => [item.id, { passed: false, reason: 'sec' }]))
        const after = Object.fromEntries(qualityCases.map((item) => [item.id, { passed: true, reason: 'poli' }]))
        qualityVersions[qualityVersions.length - 1]!.score = { passed: 0, total, mean: 1 }
        const body = sse([
          ['progress', { phase: 'before', done: total, total }],
          ['progress', { phase: 'proposal', done: 0, total: 1 }],
          ['result', { kind: 'proposed', judge: 'mistral:mistral-large-latest', before: { score: { passed: 0, total, mean: 1 }, cases }, after: { score: { passed: total, total, mean: 5 }, cases: after }, heldOut: null, proposalId: '11111111-1111-4111-8111-111111111111', instructions: 'Tu es Juriste. Cite toujours la source.' }],
        ])
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
      }
      if (method === 'POST' && sub === '/apply') {
        appliedProposals.push((request.postDataJSON() as { proposalId: string }).proposalId)
        const version = { id: id(), version: qualityVersions.length + 1, instructions: 'Tu es Juriste. Cite toujours la source.', source: 'improvement', score: { passed: 2, total: 2, mean: 5 }, createdAt: now }
        qualityVersions.push(version)
        return json(route, { agent: { id: qualityPath[1], instructions: version.instructions }, version })
      }
    }
    // Compétences : bibliothèque, fichiers (texte), versions.
    if (key === 'GET /skills') return json(route, { skills })
    if (key === 'POST /skills') {
      const body = request.postDataJSON() as { name: string; description: string; instructions: string; confidential: boolean }
      const skill = { id: id(), ...body, version: 1, mine: true, canEdit: true, shared: false, files: [] as { id: string; name: string; mediaType: string; size: number; createdAt: string }[], updatedAt: now }
      skills.unshift(skill)
      return json(route, { skill }, 201)
    }
    const skillPath = /^\/skills\/(?!import$)([^/]+)(\/files)?(?:\/([^/]+))?$/.exec(path)
    if (skillPath) {
      const skill = skills.find((item) => item.id === skillPath[1])
      if (!skill) return json(route, { error: 'Not found' }, 404)
      if (method === 'PUT' && !skillPath[2]) {
        Object.assign(skill, request.postDataJSON(), { version: skill.version + 1 })
        return json(route, { skill })
      }
      if (method === 'DELETE' && !skillPath[2]) {
        skills.splice(skills.indexOf(skill), 1)
        return route.fulfill({ status: 204 })
      }
      if (method === 'POST' && skillPath[2]) {
        const name = decodeURIComponent(request.headers()['x-file-name'] ?? 'fichier')
        const file = { id: id(), name, mediaType: 'text/markdown', size: request.postDataBuffer()?.length ?? 0, createdAt: now }
        skill.files.push(file)
        return json(route, { file }, 201)
      }
      if (method === 'DELETE' && skillPath[3]) {
        skill.files = skill.files.filter((file) => file.id !== skillPath[3])
        return route.fulfill({ status: 204 })
      }
    }
    const agentPath = /^\/agents\/([^/]+)$/.exec(path)
    if (method === 'PUT' && agentPath) {
      agentSaves.push(request.postDataJSON() as Record<string, unknown>)
      const input = request.postDataJSON() as Record<string, unknown>
      return json(route, { agent: { ...input, id: agentPath[1], createdBy: 'u-1', canEdit: true } })
    }
    if (key === 'POST /agents') {
      const input = request.postDataJSON() as Record<string, unknown>
      return json(route, { agent: { ...input, id: id(), createdBy: 'u-1', canEdit: true } }, 201)
    }
    if (key === 'GET /models') {
      return json(route, { providers: [{ id: 'mistral', available: true, allowed: true, models: [{ id: 'mistral-small-latest', label: 'mistral-small' }, { id: 'mistral-large-latest', label: 'mistral-large' }] }], defaultModel: { provider: 'mistral', model: 'mistral-small-latest' } })
    }
    if (key === 'GET /usage') {
      return json(route, { usage: { period: '2026-10-01', total: { inputTokens: 1200, outputTokens: 300 }, byProvider: { mistral: { inputTokens: 1200, outputTokens: 300 } }, mine: { inputTokens: 800, outputTokens: 200 }, tools: { web: 42 } }, limits: { monthly: 100_000, providers: {}, tools: { web: 500 } } })
    }
    if (key === 'GET /organization') {
      return json(route, {
        organization: { id: ORG, name: 'Polaris', ...(role === 'owner' || role === 'admin' ? { sso: { alias: null, defaultRole: 'member' } } : {}) },
        settings: { allowedProviders: ['mistral'], monthlyTokenLimit: 100_000, providerTokenLimits: {}, embeddingProvider: null, linksEnabled: false, linkDomains: [], tools: options.orgTools ?? ['search_knowledge', 'save_to_knowledge'], toolLimits: { web: 500 } },
        configuredProviders: ['mistral'],
        embeddingProviders: [],
        platformTools: options.platformTools ?? ['search_knowledge', 'save_to_knowledge', 'delegate'],
      })
    }
    if (key === 'PUT /organization/settings') {
      const body = request.postDataJSON() as Record<string, unknown>
      savedSettings.push(body)
      return json(route, { settings: body })
    }
    if (key === 'GET /organization/members') {
      return json(route, { members: [{ userId: 'u-1', email: 'camille@polaris.example', role, joinedAt: now, monthlyTokens: 1000 }], invitations: [] })
    }
    if (key === 'GET /organization/mcp-servers') return json(route, { servers: mcpServers })
    const serverPath = /^\/organization\/mcp-servers\/([^/]+)(\/discover|\/approve)?$/.exec(path)
    const target = serverPath ? mcpServers.find((item) => item.id === serverPath[1]) : undefined
    if (serverPath && !target) return json(route, { error: 'Not found' }, 404)
    if (serverPath && target && method === 'DELETE' && !serverPath[2]) {
      mcpServers.splice(mcpServers.indexOf(target), 1)
      return route.fulfill({ status: 204 })
    }
    if (serverPath && target && method === 'PATCH' && !serverPath[2]) {
      const body = request.postDataJSON() as { enabled: boolean }
      target.status = !body.enabled ? 'disabled' : target.tools.length ? 'approved' : 'pending'
      return json(route, { server: target })
    }
    // Comme l'API : un serveur OAuth ne se lit qu'avec le compte de l'administrateur.
    if (serverPath && target && method === 'POST' && serverPath[2] === '/discover') {
      if (target.auth === 'oauth' && !mcpConnected.has(target.id)) return json(route, { error: 'Bad request', reason: 'connect_required' }, 400)
      const tool = (name: string, title: string, readOnlyHint: boolean, description: string, param: string) => ({
        name, title, description, readOnlyHint, supported: true, approved: target.tools.some((item) => item.name === name), fingerprint: `fp-${name}`,
        inputSchema: { properties: { [param]: { type: 'string', description: `${param} demandé` } } },
      })
      return json(route, { tools: [
        tool('search', 'Rechercher', true, 'Cherche dans l’espace de travail.', 'query'),
        tool('fetch', 'Lire une page', true, 'Lit une page par son identifiant.', 'id'),
        tool('create_page', 'Créer une page', false, 'Crée une page.', 'title'),
        // Piège : annoncé en lecture par l'éditeur, alors que son nom dit le contraire.
        tool('delete_page', 'Supprimer une page', true, 'Supprime une page.', 'id'),
      ] })
    }
    if (serverPath && target && method === 'POST' && serverPath[2] === '/approve') {
      const body = request.postDataJSON() as { tools: { name: string; access: string }[] }
      approveCalls.push({ id: target.id, tools: body.tools.map(({ name, access }) => ({ name, access })) })
      target.tools = body.tools.map(({ name, access }) => ({ name, title: null, access }))
      target.status = 'approved'
      return json(route, { server: target })
    }
    // Catalogue : le vrai (données de l'API), pour voir les vrais logos.
    if (key === 'GET /mcp-catalog') return json(route, { connectors: CONNECTOR_CATALOG })
    const catalogAdd = /^\/organization\/mcp-catalog\/([a-z0-9-]+)$/.exec(path)
    if (catalogAdd && method === 'POST') {
      const connector = CONNECTOR_CATALOG.find((item) => item.id === catalogAdd[1])
      if (!connector) return json(route, { error: 'Not found' }, 404)
      const body = request.postDataJSON() as { tenant?: string; token?: string; clientId?: string }
      catalogAdds.push({ id: connector.id, ...body })
      const server: MockServer = { id: id(), name: connector.name, status: 'pending', auth: connector.auth === 'oauth' ? 'oauth' : 'token', kind: 'mcp', url: connector.url, hasToken: Boolean(body.token), catalogId: connector.id, tools: [] }
      mcpServers.push(server)
      return json(route, { server }, 201)
    }
    if (key === 'POST /skills/import') {
      const skill = { id: id(), name: 'note-de-synthese', description: 'Rédiger une note de synthèse juridique', instructions: '1. Faits.', confidential: url.searchParams.get('confidential') === 'true', version: 1, mine: true, canEdit: true, shared: false, files: [{ id: id(), name: 'references/plan.md', mediaType: 'text/markdown', size: 12, createdAt: now }], updatedAt: now }
      skills.unshift(skill)
      return json(route, { skill, skipped: [{ name: 'scripts/fill.py', reason: 'script' }] }, 201)
    }
    if (key === 'POST /organization/mcp-servers') {
      const body = request.postDataJSON() as { name: string; url: string; openapi?: unknown }
      createdConnectors.push(body)
      const server: MockServer = { id: id(), name: body.name, status: 'pending', kind: body.openapi ? 'openapi' : 'mcp', auth: (body as { oauth?: unknown }).oauth ? 'oauth' : 'token', url: body.url, hasToken: false, tools: [] }
      mcpServers.push(server)
      return json(route, { server }, 201)
    }
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
    if (key === 'GET /me/files') return json(route, { files: library })
    if (method === 'DELETE' && path.startsWith('/me/files/')) {
      const index = library.findIndex((item) => item.id === path.slice('/me/files/'.length))
      if (index !== -1) library.splice(index, 1)
      return route.fulfill({ status: 204 })
    }
    if (key === 'GET /me/presets') return json(route, { presets })
    if (key === 'POST /me/presets') {
      const body = request.postDataJSON() as { name: string; settings: Record<string, unknown> }
      const preset = { id: `preset-${++counter}`, name: body.name, settings: body.settings, createdAt: new Date().toISOString() }
      presets.push(preset)
      return json(route, { preset }, 201)
    }
    if (method === 'DELETE' && path.startsWith('/me/presets/')) {
      const index = presets.findIndex((item) => item.id === path.slice('/me/presets/'.length))
      if (index !== -1) presets.splice(index, 1)
      return route.fulfill({ status: 204 })
    }
    if (key === 'POST /prompts') {
      const body = request.postDataJSON() as { name: string; content: string }
      const prompt = { id: id(), ...body, mine: true, shared: false, canEdit: true, updatedAt: now }
      prompts.unshift(prompt)
      return json(route, { prompt }, 201)
    }
    const accessPath = /^\/(agent|prompt)s\/([^/]+)\/access$/.exec(path)
    if (accessPath && method === 'GET') return json(route, { grants: access.get(`${accessPath[1]}:${accessPath[2]}`) ?? [] })
    if (accessPath && method === 'PUT') {
      const { grants } = request.postDataJSON() as { grants: unknown[] }
      access.set(`${accessPath[1]}:${accessPath[2]}`, grants)
      accessCalls.push({ type: accessPath[1]!, id: accessPath[2]!, grants })
      const prompt = prompts.find((item) => item.id === accessPath[2])
      if (prompt) prompt.shared = grants.length > 0
      return json(route, { grants })
    }
    if (key === 'GET /sharing/directory') return json(route, { members: directory, groups: groups.map((group) => ({ id: group.id, name: group.name, memberCount: group.memberIds.length })) })
    if (key === 'GET /groups') return json(route, { groups })
    if (key === 'POST /groups') {
      const group = { id: id(), name: (request.postDataJSON() as { name: string }).name, memberIds: [] as string[] }
      groups.push(group)
      return json(route, { group }, 201)
    }
    const groupPath = /^\/groups\/([^/]+)$/.exec(path)
    if (groupPath && method === 'PUT') {
      const group = groups.find((item) => item.id === groupPath[1])
      if (!group) return json(route, { error: 'Not found' }, 404)
      Object.assign(group, request.postDataJSON())
      return json(route, { group })
    }
    if (groupPath && method === 'DELETE') {
      groups.splice(groups.findIndex((item) => item.id === groupPath[1]), 1)
      return route.fulfill({ status: 204 })
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
      if (method === 'POST' && rest === '/regenerate') {
        // Comme le serveur : nouvelle version (sœur) de la dernière réponse ; avec un modèle, signée par lui.
        const body = (request.postDataJSON() ?? {}) as { model?: { provider: string; model: string } }
        regenerateCalls.push(body)
        const list = messages.get(conversationId!) ?? []
        const previous = list.pop() as Record<string, unknown> & { id: string; author?: string }
        const next = {
          id: id(),
          role: 'assistant' as const,
          content: options.compareAnswer ?? 'Autre réponse.',
          createdAt: now,
          author: body.model ? `model:${body.model.provider}:${body.model.model}` : previous.author,
          branch: { index: 1, count: 2, siblings: [previous.id, ''] },
        }
        next.branch.siblings[1] = next.id
        versions.set(previous.id, { ...previous, branch: { index: 0, count: 2, siblings: next.branch.siblings } })
        versions.set(next.id, next)
        list.push(next)
        const chunks = next.content.match(/[\s\S]{1,40}/g) ?? []
        const sseBody = [...chunks.map((text) => `event: token\ndata: ${JSON.stringify({ text })}\n\n`), `event: done\ndata: ${JSON.stringify({ assistantMessage: next })}\n\n`].join('')
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody })
      }
      if (method === 'POST' && rest === '/branch') {
        const chosen = versions.get((request.postDataJSON() as { messageId: string }).messageId)
        const list = messages.get(conversationId!) ?? []
        if (!chosen) return json(route, { error: 'Not found' }, 404)
        list[list.length - 1] = chosen as (typeof list)[number]
        branchCalls.push(String(chosen.id))
        return json(route, { messages: list })
      }
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
      if (method === 'PATCH' && rest === '') {
        // Comme le serveur : agent OU modèle, changeable à tout moment.
        const conversation = conversations.find((item) => item.id === conversationId)
        const body = (request.postDataJSON() ?? {}) as { agentId?: string | null; model?: unknown; settings?: { instructions?: string }; archived?: boolean; tags?: string[] }
        conversationPatches.push(body)
        // Comme le serveur : des instructions avec une donnée de santé sont refusées.
        if (/diabétique/i.test(body.settings?.instructions ?? '')) return json(route, { error: 'Invalid request', reason: 'instructions_sensitive' }, 400)
        if (conversation && ('agentId' in body || 'model' in body)) Object.assign(conversation, { agentId: body.agentId ?? null, model: body.model ?? null })
        if (conversation) {
          const filed = conversation as Record<string, unknown>
          if (body.settings) {
            if (Object.keys(body.settings).length) filed.settings = body.settings
            else delete filed.settings
          }
          if (body.archived !== undefined) {
            if (body.archived) filed.archived = true
            else delete filed.archived
          }
          if (body.tags !== undefined) {
            if (body.tags.length) filed.tags = body.tags
            else delete filed.tags
          }
        }
        return json(route, { conversation })
      }
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
              ...(options.approval.team
                ? ([
                    ['step', { id: 'd1', name: 'delegate_task', status: 'running', summary: 'RH' }],
                    ['step', { id: 'd1/k1', name: 'search_knowledge', status: 'done', agent: 'RH', parent: 'd1' }],
                  ] as [string, unknown][])
                : []),
              ['step', { id: APPROVAL.stepId, name: APPROVAL.tool, status: 'running', ...(options.approval.team ? { agent: 'RH', parent: 'd1' } : {}) }],
              ['approval', { ...APPROVAL, ...(options.approval.team ? { onBehalfOf: 'RH' } : {}), ...(options.approval.warning ? { warning: true } : {}), ...(options.approval.exposure ? { exposure: true, title: 'Envoyer une recherche sur le web', detail: 'verification 7731-ZETA' } : {}) }],
              ['paused', {}],
            ]),
          })
        }
        // Comme le serveur : un n° de sécurité sociale bascule la conversation en local, ou la refuse.
        if (options.sensitive && /1 85 05 78 006 084 91/.test(content)) {
          if (options.sensitive === 'blocked') return json(route, { error: 'Local model required', reason: 'sensitive_requires_local', categories: ['nir'] }, 409)
          Object.assign(conversations.find((item) => item.id === conversationId) ?? {}, { sensitive: true })
        }
        const answer = options.answer ?? 'Bonjour !'
        const userMessage = { id: id(), role: 'user' as const, content, createdAt: now }
        // Auteur de la réponse : l'agent ou le modèle de la conversation à cet instant.
        const current = conversations.find((item) => item.id === conversationId) as { agentId: string | null; model: { provider: string; model: string } | null } | undefined
        // Sans choix : le modèle par défaut (celui de GET /models).
        const author = current?.agentId ? `agent:${current.agentId}` : current?.model ? `model:${current.model.provider}:${current.model.model}` : 'model:mistral:mistral-small-latest'
        const assistantMessage = { id: id(), role: 'assistant' as const, content: answer, createdAt: now, author, ...(options.continuation ? { incomplete: true } : {}) }
        messages.get(conversationId!)?.push(userMessage, assistantMessage)
        // Comme le serveur : le premier message donne son titre à la conversation.
        const conversation = conversations.find((item) => item.id === conversationId)
        if (conversation && conversation.title === 'Nouvelle conversation') conversation.title = content.slice(0, 80)
        const chunks = answer.match(/[\s\S]{1,40}/g) ?? []
        const body = [...chunks.map((text) => `event: token\ndata: ${JSON.stringify({ text })}\n\n`), `event: done\ndata: ${JSON.stringify({ userMessage, assistantMessage })}\n\n`].join('')
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
      }
      if (method === 'POST' && rest === '/attachments/copy') {
        const source = library.find((item) => item.id === (request.postDataJSON() as { attachmentId: string }).attachmentId)
        if (!source) return json(route, { error: 'Not found' }, 404)
        copies.push(source.id)
        return json(route, { attachment: { ...source, id: id(), messageId: null } }, 201)
      }
      if (method === 'POST' && rest === '/fork') {
        // Comme le serveur : copie de la conversation jusqu'au message choisi (inclus).
        const source = conversations.find((item) => item.id === conversationId)
        const list = messages.get(conversationId!) ?? []
        const end = list.findIndex((item) => item.id === (request.postDataJSON() as { messageId: string }).messageId)
        if (!source || end === -1) return json(route, { error: 'Not found' }, 404)
        const copy = { ...structuredClone(source), id: id(), createdAt: now, updatedAt: now }
        conversations.unshift(copy)
        messages.set(copy.id, list.slice(0, end + 1).map((item) => ({ ...structuredClone(item), id: id() })))
        forks.push({ from: conversationId!, to: copy.id })
        return json(route, { conversation: copy }, 201)
      }
      if (method === 'POST' && rest === '/continue') {
        // Comme le serveur : la suite s'ajoute à la dernière réponse (même message).
        const list = messages.get(conversationId!) ?? []
        const last = list.at(-1) as ({ incomplete?: boolean; content: string } & Record<string, unknown>) | undefined
        if (!last?.incomplete || !options.continuation) return json(route, { error: 'Invalid request' }, 400)
        continueCalls.push(conversationId!)
        last.content += options.continuation
        delete last.incomplete
        const body = [`event: token\ndata: ${JSON.stringify({ text: options.continuation })}\n\n`, `event: done\ndata: ${JSON.stringify({ assistantMessage: last })}\n\n`].join('')
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
      }
    }
    unknown.push(key)
    return json(route, { error: 'Not found' }, 404)
  })

  return { unknown, feedbackCalls, decisions, cancels: () => cancels, oauthCallbacks, createdConnectors, audioCalls, speechCalls, savedSettings, appliedProposals, decisionCalls, schedules, scheduleRuns, savedPreferences, conversationPatches, presets, continueCalls, forks, library, copies, regenerateCalls, branchCalls, accessCalls, groups, skills, agentSaves, catalogAdds, mcpServers, emptyJsonBodies, approveCalls }
}
