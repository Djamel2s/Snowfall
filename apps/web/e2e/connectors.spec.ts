import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : connecteurs dans la barre latérale. Une liste, une fiche par
// connecteur, une action principale à la fois : ajouter → se connecter →
// choisir les outils → prêt. Plus l'import d'une compétence zippée.

async function openPanel(page: Page, name: string) {
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name, exact: true }).first().click()
}

test('administrateur : Notion du catalogue → connexion → retour sur sa fiche → lecture seule → prêt', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  await page.goto('/')
  await openPanel(page, 'Connecteurs')
  // Rien d'ajouté : la liste invite à parcourir le catalogue.
  await expect(page.getByRole('tab', { name: 'Ajoutés (0)' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Parcourir le catalogue' }).click()
  const catalog = page.getByRole('region', { name: 'Catalogue' })
  await expect(catalog.getByRole('button', { name: /Gmail/ })).toBeVisible()
  expect(await catalog.locator('.connector-tile').count()).toBeGreaterThanOrEqual(50)
  await page.screenshot({ path: info.outputPath('catalogue.png') })

  await catalog.getByRole('textbox', { name: 'Chercher un connecteur' }).fill('notion')
  await expect(catalog.locator('.connector-tile')).toHaveCount(1)
  await catalog.getByRole('button', { name: /Notion/ }).click()
  const entry = page.getByRole('region', { name: 'Notion', exact: true })
  await expect(entry.getByText(/Vous vous connecterez avec votre compte/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('fiche-catalogue.png') })

  // Un bouton : l'ajout enchaîne sur la connexion chez l'éditeur, puis le retour rouvre la fiche.
  await entry.getByRole('button', { name: 'Ajouter et se connecter' }).click()
  await expect.poll(() => api.catalogAdds).toEqual([{ id: 'notion' }])
  await expect.poll(() => api.oauthCallbacks.length).toBe(1)
  await expect(page).toHaveURL(/\/$/)
  const card = page.getByRole('region', { name: 'Notion', exact: true })
  const steps = card.getByRole('list', { name: 'Étapes' })
  await expect(steps.locator('li.done')).toHaveCount(2)
  await expect(steps.locator('[aria-current="step"]')).toHaveText(/Outils/)

  // Outils lus d'eux-mêmes ; lecture seule proposée par défaut.
  await expect(card.getByRole('radio', { name: /Lecture seule/ })).toHaveAttribute('aria-checked', 'true')
  // Ce qui sera approuvé reste visible ; l'outil « lecture » au nom de suppression est écarté et signalé.
  const included = card.locator('.tool-included')
  await expect(included.locator('li')).toHaveText(['Rechercher', 'Lire une page'])
  await expect(included).toContainText('1 outil(s) annoncé(s) en lecture mais au nom de modification')
  await page.screenshot({ path: info.outputPath('choix-outils.png') })
  await card.getByRole('button', { name: 'Activer (2 outil(s))' }).click()
  await expect.poll(() => api.approveCalls).toEqual([{ id: expect.any(String), tools: [{ name: 'search', access: 'read' }, { name: 'fetch', access: 'read' }] }])
  await expect(card.getByText('Prêt : connecté avec votre compte.')).toBeVisible()
  await expect(steps.locator('li.done')).toHaveCount(4)
  await page.screenshot({ path: info.outputPath('pret.png') })

  // Retour à la liste : la puce dit où il en est.
  await card.getByRole('button', { name: 'Connecteurs', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ouvrir Notion' })).toContainText('Prêt')
  expect(api.emptyJsonBodies).toEqual([])
})

test('administrateur : outils au choix, détail lisible, écriture marquée', async ({ page }) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  await page.goto('/')
  await openPanel(page, 'Connecteurs')
  await page.getByRole('tab', { name: 'Catalogue' }).click()
  await page.getByRole('textbox', { name: 'Chercher un connecteur' }).fill('notion')
  await page.getByRole('region', { name: 'Catalogue' }).getByRole('button', { name: /Notion/ }).click()
  await page.getByRole('button', { name: 'Ajouter et se connecter' }).click()
  const card = page.getByRole('region', { name: 'Notion', exact: true })
  await card.getByRole('radio', { name: /Personnalisé/ }).click()
  await card.getByRole('button', { name: 'Détails de Créer une page' }).click()
  await expect(card.getByText('Crée une page.')).toBeVisible()
  await expect(card.getByText('title', { exact: true })).toBeVisible()
  await card.getByRole('checkbox', { name: 'Créer une page' }).check()
  await expect(card.getByRole('combobox', { name: 'Droit de Créer une page' })).toHaveValue('write')
  await card.getByRole('checkbox', { name: 'Lire une page' }).uncheck()
  // L'outil piégé : signalé, et proposé en écriture (donc soumis à l'accord) s'il est coché.
  const trap = card.locator('li', { has: page.getByRole('checkbox', { name: 'Supprimer une page' }) })
  await expect(trap).toContainText('son nom suggère une modification')
  await expect(card.getByRole('combobox', { name: 'Droit de Supprimer une page' })).toHaveValue('write')
  await card.getByRole('button', { name: 'Activer (2 outil(s))' }).click()
  await expect.poll(() => api.approveCalls[0]?.tools).toEqual([{ name: 'search', access: 'read' }, { name: 'create_page', access: 'write' }])
})

test('administrateur : SharePoint demande le tenant et l’application OAuth, préversion signalée', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  await page.goto('/')
  await openPanel(page, 'Connecteurs')
  await page.getByRole('tab', { name: 'Catalogue' }).click()
  const catalog = page.getByRole('region', { name: 'Catalogue' })
  await catalog.getByRole('group', { name: 'Catégories' }).getByRole('button', { name: 'Microsoft' }).click()
  await catalog.getByRole('button', { name: /SharePoint et OneDrive/ }).click()
  const entry = page.getByRole('region', { name: 'SharePoint et OneDrive' })
  await expect(entry.getByText(/Préversion de l'éditeur/)).toBeVisible()
  await expect(entry.getByText(/Créez d'abord une application OAuth/)).toBeVisible()
  await entry.getByRole('textbox', { name: 'Identifiant du tenant Microsoft (GUID)' }).fill('11111111-2222-3333-4444-555555555555')
  await entry.getByRole('textbox', { name: 'Identifiant client OAuth', exact: true }).fill('app-entra')
  await page.screenshot({ path: info.outputPath('microsoft.png') })
  await entry.getByRole('button', { name: 'Ajouter et se connecter' }).click()
  await expect.poll(() => api.catalogAdds).toEqual([{ id: 'sharepoint-onedrive', tenant: '11111111-2222-3333-4444-555555555555', clientId: 'app-entra' }])
})

test('membre : connecteurs prêts seulement, connexion depuis la fiche, pas de catalogue', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'member', mcpOAuth: true })
  await page.goto('/')
  await openPanel(page, 'Connecteurs')
  const mine = page.getByRole('region', { name: "Connecteurs de l'organisation" })
  await expect(mine.locator('.connector-logo svg path')).toHaveCount(1)
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Catalogue' })).toHaveCount(0)
  const tile = mine.getByRole('button', { name: 'Ouvrir Jira' })
  await expect(tile).toContainText('À connecter')
  await tile.click()

  const card = page.getByRole('region', { name: 'Jira', exact: true })
  // Pas d'étapes d'administration pour un membre : une phrase, un bouton.
  await expect(card.getByRole('list', { name: 'Étapes' })).toHaveCount(0)
  await card.getByRole('button', { name: 'Se connecter à Jira' }).click()
  await expect.poll(() => api.oauthCallbacks).toEqual([{ state: 'S'.repeat(43), code: 'code-42' }])
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('status').filter({ hasText: 'Connecté à Jira.' })).toBeVisible()
  const after = page.getByRole('region', { name: 'Jira', exact: true })
  await expect(after.getByText('Prêt : connecté avec votre compte.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('membre-connecte.png') })
  await after.getByRole('button', { name: 'Déconnecter Jira' }).click()
  await expect(after.getByRole('button', { name: 'Se connecter à Jira' })).toBeVisible()
})

test('compétence importée depuis un .zip : fichiers repris, scripts signalés', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/')
  await openPanel(page, 'Compétences')
  await page.getByRole('button', { name: 'Importer une compétence (.zip)' }).click()
  const box = page.getByRole('region', { name: 'Importer une compétence (.zip)' })
  await box.locator('input[type="file"]').setInputFiles({ name: 'note.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004fake') })
  await expect(page.getByRole('button', { name: /note-de-synthese/ }).first()).toBeVisible()
  await expect(page.getByRole('status')).toContainText('scripts/fill.py (script)')
  expect(api.skills[0]).toMatchObject({ name: 'note-de-synthese' })
})
