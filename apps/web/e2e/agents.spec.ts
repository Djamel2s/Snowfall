import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : le catalogue d'agents. Cartes (avatar, nom, modèle, outils),
// recherche, « les miens », dupliquer, démarrer une conversation.

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

test('catalogue : cartes, recherche, filtre « les miens »', async ({ page }, info) => {
  const api = await mockApi(page, { agents })
  await openAgents(page)
  const cards = page.locator('.agent-card:not(.agent-card-new)')
  await expect(cards).toHaveCount(4)
  // Nom et modèle sur chaque carte.
  await expect(cards.first()).toContainText('Juriste')
  await expect(cards.first()).toContainText('mistral-small')
  // Taux de réponses utiles : seulement l'agent noté (5 avis au moins côté serveur).
  await expect(page.locator('.agent-card-rating')).toHaveCount(1)
  await expect(cards.filter({ hasText: 'Support RH' }).locator('.agent-card-rating')).toHaveText('88 %')
  await page.screenshot({ path: info.outputPath('catalogue.png') })

  await page.getByRole('radio', { name: 'Les miens' }).click()
  await expect(cards).toHaveCount(2)
  await page.getByRole('radio', { name: 'Tous' }).click()
  await page.getByRole('searchbox', { name: 'Rechercher un agent' }).fill('veille')
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('Veille concurrentielle')
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

test('cliquer une carte démarre une conversation avec l’agent', async ({ page }) => {
  await mockApi(page, { agents })
  await openAgents(page)
  const created = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/conversations'))
  await page.locator('.agent-card-main', { hasText: 'Juriste' }).click()
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

test('studio : consulter des agents — choix des spécialistes enregistré avec l’agent', async ({ page }) => {
  await mockApi(page, { agents, orgTools: ['search_knowledge', 'save_to_knowledge', 'delegate'] })
  await openAgents(page)
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  await page.getByRole('group', { name: 'Outils' }).getByRole('button', { name: /Consulter des agents/ }).click()
  const specialists = page.getByRole('group', { name: /Agents consultables/ })
  // Un agent ne se consulte pas lui-même.
  await expect(specialists.getByRole('button', { name: 'Juriste' })).toHaveCount(0)
  await specialists.getByRole('button', { name: 'Support RH' }).click()
  const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/agents/'))
  await page.getByRole('button', { name: /Enregistrer/ }).first().click()
  const body = (await saved).postDataJSON() as { tools: string[]; delegates: string[] }
  expect(body.tools).toContain('delegate')
  expect(body.delegates).toEqual(['agent-supportrh'])
})
