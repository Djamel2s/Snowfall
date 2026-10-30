import { expect, test, type Page } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : une conversation n'entre dans l'historique qu'au premier message ;
// tous les panneaux suivent le même format (Nouveau…, recherche, sections) ;
// naviguer referme le studio d'agent.

async function open(page: Page, name: string) {
  // Mobile : ouvrir le tiroir s'il est fermé (déjà ouvert, le bouton est sous le voile).
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (!(await page.locator('.sidebar.sidebar-open').count()) && (await menu.isVisible().catch(() => false))) await menu.click()
  await page.getByRole('button', { name, exact: true }).first().click()
}

test('nouvelle conversation : absente de l’historique tant que rien n’est écrit ; pas de doublon vide', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/')
  const input = page.getByPlaceholder(/Posez votre question/)
  await input.waitFor()
  await open(page, 'Conversations')
  await page.getByRole('button', { name: 'Nouvelle conversation' }).first().click()
  await open(page, 'Conversations')
  await page.getByRole('button', { name: 'Nouvelle conversation' }).first().click()
  // Deux clics, une seule conversation ouverte (la vide est reprise), et rien dans l'historique.
  expect(api.conversationCreates()).toBe(1)
  await open(page, 'Conversations')
  await expect(page.getByText('Aucune conversation pour le moment.')).toBeVisible()

  await input.fill('Bonjour')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant').first()).toBeVisible()
  await open(page, 'Conversations')
  await expect(page.locator('.conversation-item')).toHaveCount(1)
  expect(api.unknown).toEqual([])
})

test('panneaux au même format : « Nouveau … », recherche, sections', async ({ page }, info) => {
  await mockApi(page, { role: 'admin', agents: [fakeAgent('Support RH', { mine: true })], platformTools: ['mcp'] })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  for (const [panel, action, search] of [
    ['Projets', 'Nouveau projet', 'Rechercher un projet'],
    ['Agents', 'Nouvel agent', 'Rechercher un agent'],
    ['Prompts', 'Nouveau prompt', 'Rechercher un prompt'],
    ['Compétences', 'Nouvelle compétence', 'Rechercher une compétence'],
    ['Connecteurs', 'Nouveau connecteur', 'Chercher un connecteur'],
  ] as const) {
    await open(page, panel)
    await expect(page.getByRole('button', { name: action })).toBeVisible()
    await expect(page.getByRole('textbox', { name: search })).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${panel}.png`) })
  }
  // Recherche dans les prompts : filtre immédiat.
  await open(page, 'Prompts')
  await page.getByRole('textbox', { name: 'Rechercher un prompt' }).fill('zzz')
  await expect(page.getByText('Aucun prompt trouvé.')).toBeVisible()
})

test('projet : liste, page du projet (conversations, documents), retour', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { projects: [{ id: 'p1', name: 'Appel d’offres 2027', createdAt: '2026-10-01', updatedAt: '2026-10-01', conversationCount: 0 }] } })
      : route.fallback(),
  )
  await page.route('**/api/projects/p1/knowledge', (route) =>
    route.fulfill({ json: { knowledge: { base: { id: 'b1' }, canManage: true, linksEnabled: true, confidential: false, embeddingModel: null, sources: [{ id: 's1', kind: 'file', name: 'Cahier des charges.pdf', status: 'ready', chunkCount: 42, size: 1200, errorCode: null, url: null, updatedAt: '2026-10-01' }] } } }),
  )
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  await open(page, 'Projets')
  await page.getByRole('textbox', { name: 'Rechercher un projet' }).fill('offres')
  await page.getByRole('button', { name: /Appel d’offres 2027/ }).click()
  const documents = page.getByRole('region', { name: 'Connaissances' })
  await expect(documents.getByRole('button', { name: 'Télécharger Cahier des charges.pdf' })).toBeVisible()
  await expect(documents.getByRole('button', { name: 'Ajouter des fichiers' })).toBeVisible()
  // Lien : le champ n'apparaît qu'à la demande.
  await expect(documents.getByRole('textbox', { name: 'Coller un lien…' })).toHaveCount(0)
  await documents.getByRole('button', { name: 'Ajouter un lien' }).click()
  await expect(documents.getByRole('textbox', { name: 'Coller un lien…' })).toBeVisible()
  await page.getByRole('button', { name: 'Projets', exact: true }).last().click()
  await expect(page.getByRole('button', { name: 'Nouveau projet' })).toBeVisible()
})

test('studio d’agent ouvert : aller dans Conversations le referme', async ({ page }) => {
  await mockApi(page, { agents: [fakeAgent('Juriste', { mine: true })] })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  await open(page, 'Agents')
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  await expect(page.getByRole('form', { name: 'Modifier l’agent' })).toBeVisible()
  await open(page, 'Agents')
  await expect(page.getByRole('form', { name: 'Modifier l’agent' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  await open(page, 'Conversations')
  await expect(page.getByRole('form', { name: 'Modifier l’agent' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Nouvelle conversation' }).first()).toBeVisible()
})
