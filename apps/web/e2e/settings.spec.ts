import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : les réglages. « Mon compte » d'un côté, l'organisation de l'autre
// (administrateurs), en rubriques ; un outil non installé reste visible.

async function openConnectors(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Connecteurs', exact: true }).first().click()
}

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/')
  // L'application d'abord : sinon, sur mobile, le bouton menu n'est pas encore là et on le saute.
  await page.getByPlaceholder(/Posez votre question/).waitFor()
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
  const mcp = page.getByRole('switch', { name: /^Connecteurs/ })
  await expect(mcp).toBeDisabled()
  await expect(page.getByText(/Connecteurs · non installé sur la plateforme/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('outils.png'), fullPage: true })

  await page.getByRole('tab', { name: 'Membres et accès' }).click()
  await expect(page.getByText('camille@polaris.example')).toBeVisible()
  await expect(page.getByRole('switch', { name: /Recherche web/ })).toHaveCount(0)
  expect(api.unknown).toEqual([])
})

test('routage automatique : question simple → modèle rapide, enregistré avec les deux modèles', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await openSettings(page)
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Modèles et quotas' }).click()
  const routing = page.getByRole('switch', { name: /Routage automatique/ })
  await expect(routing).not.toBeChecked()
  await routing.check()
  await page.getByRole('combobox', { name: 'Rapide' }).selectOption({ label: 'Mistral · mistral-small' })
  await page.getByRole('combobox', { name: 'Puissant' }).selectOption({ label: 'Mistral · mistral-large' })
  await page.screenshot({ path: info.outputPath('routage.png'), fullPage: true })
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect.poll(() => api.savedSettings.length).toBe(1)
  expect(api.savedSettings[0]!.modelRouting).toEqual({ fast: { provider: 'mistral', model: 'mistral-small-latest' }, strong: { provider: 'mistral', model: 'mistral-large-latest' } })
  expect(api.unknown).toEqual([])
})

test('atelier : exemples écrits à la main, entraînement mesuré, déploiement sur clic', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await openSettings(page)
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Modèles et quotas' }).click()
  await page.getByText('Entraîner le décideur').click()
  await expect(page.getByText('Décideur : Laya de base')).toBeVisible()
  await page.getByRole('textbox', { name: 'Un exemple par ligne' }).fill('Bonjour\nMerci\nÀ demain')
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click()
  await page.getByRole('textbox', { name: 'Un exemple par ligne' }).fill('Compare ces deux contrats\nRédige un plan de migration')
  await page.getByRole('radio', { name: 'Complexe' }).click()
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click()
  await expect(page.getByText('3 Simple · 2 Complexe · 1 en test')).toBeVisible()

  await page.getByRole('button', { name: 'Entraîner' }).click()
  const result = page.getByRole('status').filter({ hasText: 'Référence' })
  await expect(result).toContainText('Référence 22/24 · entraîné 24/24 · complexes reconnues 10/12 → 12/12')
  await page.screenshot({ path: info.outputPath('atelier.png'), fullPage: true })
  // Rien d'actif avant le clic.
  expect(api.decisionCalls.filter((call) => call.includes('activate'))).toEqual([])
  await result.getByRole('button', { name: 'Déployer' }).click()
  await expect(page.getByText('Décideur : entraîné v1')).toBeVisible()
  expect(api.unknown).toEqual([])
})

test('pseudonymisation : désactivée par défaut, activée et enregistrée', async ({ page }) => {
  const api = await mockApi(page, { role: 'admin' })
  await openSettings(page)
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Modèles et quotas' }).click()
  const toggle = page.getByRole('switch', { name: /Pseudonymiser avant un fournisseur externe/ })
  await expect(toggle).not.toBeChecked()
  await expect(page.getByRole('switch', { name: /Protéger les données sensibles/ })).toBeChecked()
  await toggle.check()
  await page.getByRole('button', { name: 'Enregistrer' }).first().click()
  await expect.poll(() => api.savedSettings.length).toBe(1)
  expect(api.savedSettings[0]!.pseudonymize).toBe(true)
})

test('MCP installé : l’outil se règle ici, les serveurs se gèrent dans Connecteurs', async ({ page }) => {
  await mockApi(page, { role: 'admin', platformTools: ['search_knowledge', 'save_to_knowledge', 'mcp'] })
  await openSettings(page)
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Outils et intégrations' }).click()
  await expect(page.getByRole('switch', { name: /^Connecteurs/ })).toBeEnabled()
  await expect(page.getByText('barre latérale › Connecteurs')).toBeVisible()
  await openConnectors(page)
  await expect(page.getByRole('tab', { name: 'Ajoutés (0)' })).toBeVisible()
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

test('connecteur OpenAPI : la spécification est lue dans le navigateur et envoyée avec l’adresse de base', async ({ page }) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  await openConnectors(page)
  await page.getByRole('tab', { name: 'Catalogue' }).click()
  await page.getByRole('button', { name: 'Connecteur personnalisé' }).click()
  const form = page.getByRole('form', { name: 'Connecteur personnalisé' })
  await form.getByRole('radio', { name: /API décrite par une spécification/ }).click()
  await form.getByRole('textbox', { name: 'Nom' }).fill('Tickets')
  await form.getByRole('textbox', { name: /Adresse du connecteur/ }).fill('https://api.example.com/v2')
  const spec = { openapi: '3.1.0', info: { title: 'Tickets', version: '1' }, paths: { '/tickets': { get: { operationId: 'list' } } } }
  await page.locator('.mcp-spec input[type=file]').setInputFiles({ name: 'tickets.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(spec)) })
  await expect(page.locator('.mcp-spec')).toContainText('tickets.json')
  await form.getByRole('button', { name: 'Ajouter', exact: true }).click()
  await expect.poll(() => api.createdConnectors).toEqual([{ name: 'Tickets', url: 'https://api.example.com/v2', openapi: { spec } }])
  // Même parcours qu'un connecteur du catalogue : sa fiche s'ouvre sur le choix des outils.
  await expect(page.getByRole('region', { name: 'Tickets' }).getByRole('radio', { name: /Lecture seule/ })).toBeVisible()
})

test('connecteur personnalisé OAuth : rien d’obligatoire hormis l’adresse, puis connexion depuis la fiche', async ({ page }) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  await openConnectors(page)
  await page.getByRole('tab', { name: 'Catalogue' }).click()
  await page.getByRole('button', { name: 'Connecteur personnalisé' }).click()
  const form = page.getByRole('form', { name: 'Connecteur personnalisé' })
  await expect(form.getByRole('radio', { name: /Chacun avec son compte/ })).toHaveAttribute('aria-checked', 'true')
  await form.getByRole('textbox', { name: 'Nom' }).fill('Wiki')
  await form.getByRole('textbox', { name: /Adresse du connecteur/ }).fill('https://wiki.example.com/mcp')
  await form.getByRole('button', { name: 'Ajouter', exact: true }).click()
  await expect.poll(() => api.createdConnectors).toEqual([{ name: 'Wiki', url: 'https://wiki.example.com/mcp', oauth: {} }])
  const card = page.getByRole('region', { name: 'Wiki' })
  await expect(card.getByRole('list', { name: 'Étapes' }).locator('[aria-current="step"]')).toHaveText(/Connexion/)
  await expect(card.getByRole('button', { name: 'Se connecter à Wiki' })).toBeVisible()
})
