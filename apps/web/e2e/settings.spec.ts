import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : les réglages. « Mon compte » d'un côté, l'organisation de l'autre
// (administrateurs), en rubriques ; un outil non installé reste visible.

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/')
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Paramètres' }).first().click()
}

test('administrateur : mon compte, puis l’organisation en rubriques', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['search_knowledge', 'save_to_knowledge', 'web_search'] })
  await openSettings(page)

  // Mon compte : profil, préférences, consommation — et rien de l'administration.
  await expect(page.getByRole('tab', { name: 'Mon compte' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Profil' }).getByText('Camille Test')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Membres' })).toHaveCount(0)
  // Consommation : les appels d'outils du mois, avec leur plafond.
  await expect(page.getByText('Recherches et pages web', { exact: true })).toBeVisible()
  await expect(page.getByText('42 / 500')).toBeVisible()
  await page.screenshot({ path: info.outputPath('compte.png'), fullPage: true })

  // Organisation : quatre rubriques, une seule affichée à la fois.
  await page.getByRole('tab', { name: 'Organisation' }).click()
  for (const name of ['Modèles et quotas', 'Connaissances', 'Outils et intégrations', 'Membres et accès']) {
    await expect(page.getByRole('tab', { name })).toBeVisible()
  }
  // Modèles et quotas : plafond mensuel des outils installés seulement (web ici, pas le code).
  await page.getByRole('tab', { name: 'Modèles et quotas' }).click()
  await expect(page.getByLabel('Recherches et pages web par mois')).toHaveValue('500')
  await expect(page.getByLabel('Exécutions de code par mois')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Outils et intégrations' }).click()
  // Installé : activable ; non installé (MCP, interpréteur) : visible, grisé, avec la raison.
  await expect(page.getByRole('switch', { name: /Recherche web/ })).toBeEnabled()
  const mcp = page.getByRole('switch', { name: /Serveurs MCP/ })
  await expect(mcp).toBeDisabled()
  await expect(page.getByText(/Serveurs MCP · non installé sur la plateforme/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('outils.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Membres et accès' }).click()
  await expect(page.getByText('camille@polaris.example')).toBeVisible()
  await expect(page.getByRole('switch', { name: /Recherche web/ })).toHaveCount(0)
  expect(api.unknown).toEqual([])
})

test('MCP installé : la rubrique outils montre aussi les serveurs', async ({ page }) => {
  await mockApi(page, { role: 'admin', platformTools: ['search_knowledge', 'save_to_knowledge', 'mcp'] })
  await openSettings(page)
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Outils et intégrations' }).click()
  await expect(page.getByRole('switch', { name: /Serveurs MCP/ })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Serveurs MCP' })).toBeVisible()
})

test('membre : seulement son compte, aucun onglet d’organisation', async ({ page }) => {
  await mockApi(page, { role: 'member' })
  await openSettings(page)
  await expect(page.getByRole('region', { name: 'Profil' }).getByText('Camille Test')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Organisation' })).toHaveCount(0)
})

test('mémoire : désactivée par défaut, activée, faits visibles et oubliables', async ({ page }, info) => {
  await mockApi(page)
  await openSettings(page)
  const card = page.getByRole('region', { name: 'Mémoire' })
  const toggle = card.getByRole('switch', { name: /Activer la mémoire/ })
  await expect(toggle).not.toBeChecked()

  const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/api/me/preferences'))
  await toggle.check()
  expect((await saved).postDataJSON()).toMatchObject({ memory: true })

  await expect(card.getByText('Travaille sur le dossier Orion')).toBeVisible()
  await card.getByRole('button', { name: /Oublier « Travaille sur le dossier Orion/ }).click()
  await expect(card.getByText('Travaille sur le dossier Orion')).toHaveCount(0)
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('memoire.png') })

  // Tout oublier : deux clics.
  await card.getByRole('button', { name: 'Tout oublier' }).click()
  await card.getByRole('button', { name: 'Cliquer encore pour tout oublier' }).click()
  await expect(card.getByText('Rien de retenu pour l’instant.')).toBeVisible()
})

test('connexion OAuth à un outil externe : retour du fournisseur, code renvoyé en POST, adresse nettoyée', async ({ page }, info) => {
  const api = await mockApi(page, { mcpOAuth: true })
  await openSettings(page)
  const card = page.getByRole('region', { name: 'Connexions' })
  await expect(card).toContainText('Non connecté')
  await card.getByRole('button', { name: 'Se connecter à Jira' }).click()

  // Retour sur /mcp/callback : le code part au serveur, l'adresse redevient « / ».
  await expect.poll(() => api.oauthCallbacks).toEqual([{ state: 'S'.repeat(43), code: 'code-42' }])
  await expect(page).toHaveURL(/\/$/)
  const after = page.getByRole('region', { name: 'Connexions' })
  await expect(after.getByRole('status')).toHaveText('Connecté à Jira.')
  await expect(after).toContainText('Connecté avec ton compte')
  await after.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('connexions.png') })
})

test('connecteur OpenAPI : la spécification est lue dans le navigateur et envoyée avec l’adresse de base', async ({ page }) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  await openSettings(page)
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Outils et intégrations' }).click()
  await page.getByRole('radio', { name: 'API OpenAPI' }).click()
  await page.getByLabel('Nom').last().fill('Tickets')
  await page.getByLabel('URL').fill('https://api.example.com/v2')
  const spec = { openapi: '3.1.0', info: { title: 'Tickets', version: '1' }, paths: { '/tickets': { get: { operationId: 'list' } } } }
  await page.locator('.mcp-spec input[type=file]').setInputFiles({ name: 'tickets.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(spec)) })
  await expect(page.locator('.mcp-spec')).toContainText('tickets.json')
  await page.getByRole('button', { name: 'Ajouter le serveur' }).click()
  await expect.poll(() => api.createdConnectors).toEqual([{ name: 'Tickets', url: 'https://api.example.com/v2', openapi: { spec } }])
  await expect(page.getByText(/^API · /)).toBeVisible()
})
