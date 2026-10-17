import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : le catalogue d'agents. Cartes (avatar, nom, modèle, outils),
// recherche, « les miens », dupliquer, démarrer une conversation.

const agents = [
  fakeAgent('Juriste', { mine: true, tools: ['search_knowledge', 'web_search'], color: 'lavender' }),
  fakeAgent('Analyste données', { mine: true, tools: ['code_interpreter'], color: 'mint' }),
  fakeAgent('Support RH', { tools: ['search_knowledge'], color: 'coral' }),
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
