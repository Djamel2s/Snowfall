import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : les agents, présentés comme l'historique des conversations
// (sections, recherche), dupliquer, démarrer une conversation.

const agents = [
  fakeAgent('Juriste', { mine: true, tools: ['search_knowledge', 'web_search'], color: 'lavender' }),
  fakeAgent('Analyste données', { mine: true, tools: ['code_interpreter'], color: 'mint' }),
  { ...fakeAgent('Support RH', { tools: ['search_knowledge'], color: 'coral' }), rating: { up: 23, total: 26 } },
  fakeAgent('Veille concurrentielle et marchés', { tools: ['web_search', 'mcp'], color: 'gold' }),
]

async function openAgents(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
}

test('agents : les miens, ceux partagés avec moi, une recherche ; taux de 👍 sur la ligne', async ({ page }, info) => {
  const api = await mockApi(page, { agents })
  await openAgents(page)
  const mine = page.getByRole('region', { name: 'Mes agents' })
  const shared = page.getByRole('region', { name: 'Partagés avec moi' })
  await expect(mine.getByRole('listitem')).toHaveCount(2)
  await expect(shared.getByRole('listitem')).toHaveCount(2)
  // Nom et modèle sur chaque ligne.
  await expect(mine.getByRole('listitem').first()).toContainText('Juriste')
  await expect(mine.getByRole('listitem').first()).toContainText('mistral-small')
  // Taux de réponses utiles : seulement l'agent noté (5 avis au moins côté serveur).
  await expect(page.locator('.list-row-chip', { hasText: '%' })).toHaveCount(1)
  await expect(shared.getByRole('listitem').filter({ hasText: 'Support RH' })).toContainText('88 %')
  await page.screenshot({ path: info.outputPath('agents.png') })

  await page.getByRole('textbox', { name: 'Rechercher un agent' }).fill('veille')
  await expect(mine).toContainText('Aucun agent trouvé.')
  await expect(shared.getByRole('listitem')).toHaveCount(1)
  await expect(shared).toContainText('Veille concurrentielle')
  // Le catalogue est filtré aussi : aucun modèle ne parle de veille.
  await expect(page.getByRole('region', { name: 'Catalogue' })).toHaveCount(0)
  expect(api.unknown).toEqual([])
})

test('dupliquer l’agent d’un collègue : copie modifiable, ouverte dans le studio', async ({ page }) => {
  await mockApi(page, { agents })
  await openAgents(page)
  const created = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/agents'))
  await page.getByRole('button', { name: 'Dupliquer Support RH' }).click()
  const body = (await created).postDataJSON() as { name: string; instructions: string; tools: string[] }
  expect(body).toMatchObject({ name: 'Support RH (copie)', instructions: 'Tu es Support RH.', tools: ['search_knowledge'] })
  await expect(page.getByLabel(/Nom/).first()).toHaveValue('Support RH (copie)')
})

test('cliquer un agent démarre une conversation avec lui', async ({ page }) => {
  await mockApi(page, { agents })
  await openAgents(page)
  const created = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/conversations'))
  await page.getByRole('region', { name: 'Mes agents' }).getByRole('button', { name: /^Juriste/ }).click()
  expect(((await created).postDataJSON() as { agentId: string }).agentId).toBe('agent-juriste')
})

test('studio : réglages des réponses enregistrés avec l’agent', async ({ page }, info) => {
  await mockApi(page, { agents })
  await openAgents(page)
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  const answers = page.getByRole('group', { name: 'Réponses' })
  await answers.getByRole('radio', { name: 'Précise' }).click()
  await answers.getByRole('radio', { name: 'Concise' }).click()
  await page.screenshot({ path: info.outputPath('studio.png') })
  const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/agents/'))
  await page.getByRole('button', { name: /Enregistrer/ }).first().click()
  expect(((await saved).postDataJSON() as { parameters: unknown }).parameters).toEqual({ creativity: 'precise', length: 'concise' })
})

test('studio : son équipe se choisit directement, l’outil suit', async ({ page }) => {
  await mockApi(page, { agents, orgTools: ['search_knowledge', 'save_to_knowledge', 'delegate'] })
  await openAgents(page)
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  const specialists = page.getByRole('group', { name: 'Son équipe' })
  // Un agent ne se consulte pas lui-même.
  await expect(specialists.getByRole('switch', { name: 'Juriste' })).toHaveCount(0)
  await specialists.getByRole('switch', { name: 'Support RH' }).check()
  const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/agents/'))
  await page.getByRole('button', { name: /Enregistrer/ }).first().click()
  const body = (await saved).postDataJSON() as { tools: string[]; delegates: string[] }
  expect(body.tools).toContain('delegate')
  expect(body.delegates).toEqual(['agent-supportrh'])
})

test('studio : ce que l’agent peut faire — une ligne par capacité, écritures signalées', async ({ page }, info) => {
  await mockApi(page, { agents, mcpOAuth: true, orgTools: ['search_knowledge', 'save_to_knowledge', 'web_search', 'mcp'], platformTools: ['search_knowledge', 'save_to_knowledge', 'web_search', 'mcp'] })
  await openAgents(page)
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  const can = page.getByRole('region', { name: 'Ce que l’agent peut faire'.replace('’', "'") })
  const builtIn = can.getByRole('group', { name: 'Capacités' })
  await expect(builtIn.getByRole('switch', { name: 'Chercher dans ses documents' })).toBeChecked()
  await expect(builtIn.getByRole('switch', { name: 'Chercher sur le web' })).toBeChecked()
  // Écrire demande l'accord : c'est dit sur la ligne même.
  await expect(builtIn.locator('label', { hasText: 'Enrichir ses documents' })).toContainText('Vous demande avant d’agir'.replace('’', "'"))
  // Connecteur choisi directement, sans activer d'abord un outil « Connecteurs ».
  const connectors = can.getByRole('group', { name: 'Connecteurs' })
  await connectors.getByRole('switch', { name: 'Jira' }).check()
  await builtIn.getByRole('switch', { name: 'Chercher sur le web' }).uncheck()
  await expect(can.getByText('2 activé(s)')).toBeVisible()
  await can.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('capacites.png') })
  const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/agents/'))
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  const body = (await saved).postDataJSON() as { tools: string[]; mcpServers: string[] }
  expect(body.tools).toEqual(['search_knowledge', 'mcp'])
  expect(body.mcpServers).toEqual(['mcp-1'])
})

test('studio : « Enregistrer et tester » ouvre une conversation avec l’agent', async ({ page }) => {
  await mockApi(page, { agents })
  await openAgents(page)
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/agents/'))
  const created = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/conversations'))
  await page.getByRole('button', { name: 'Enregistrer et tester' }).click()
  await saved
  expect(((await created).postDataJSON() as { agentId: string }).agentId).toBe('agent-juriste')
  await expect(page.getByRole('form', { name: 'Modifier l’agent' })).toHaveCount(0)
})
