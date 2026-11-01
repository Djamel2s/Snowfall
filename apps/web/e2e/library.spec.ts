import { expect, test, type Page } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : la bibliothèque de connaissances. Créer une base, ranger des
// documents en dossiers, la rattacher à un agent ; une base partagée en
// lecture ne se rattache pas à un agent.

async function openSpace(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (!(await page.locator('.sidebar.sidebar-open').count()) && (await menu.isVisible().catch(() => false))) await menu.click()
  await page.getByRole('button', { name, exact: true }).first().click()
}

test('créer une base, un dossier, y déposer un document, le ranger ailleurs ; fil d’Ariane', async ({ page }) => {
  const api = await mockApi(page)
  await page.goto('/')
  await openSpace(page, 'Connaissances')
  await expect(page.getByText('Crée une base, puis range-y tes documents en dossiers.')).toBeVisible()

  await page.getByRole('button', { name: 'Nouvelle base' }).click()
  await page.getByRole('textbox', { name: 'Nom de la base' }).fill('Politiques RH')
  await page.keyboard.press('Enter')
  // La base créée s'ouvre.
  await expect(page.locator('.project-view-head strong')).toHaveText('Politiques RH')

  await page.getByRole('button', { name: 'Nouveau dossier' }).click()
  await page.getByRole('textbox', { name: 'Nom du dossier' }).fill('Contrats')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Ouvrir le dossier Contrats' }).click()
  await expect(page.getByRole('navigation', { name: 'Emplacement' })).toContainText('Contrats')

  await page.locator('.library-base input[type="file"]').setInputFiles({ name: 'cdi.txt', mimeType: 'text/plain', buffer: Buffer.from('Période d’essai : quatre mois.') })
  await expect(page.getByRole('button', { name: 'Ouvrir cdi.txt' })).toBeVisible()
  expect(api.kbCalls.some((call) => call.startsWith('file:cdi.txt:') && !call.endsWith(':root'))).toBe(true)

  // Ranger le document à la racine : il quitte le dossier.
  await page.locator('.list-row-wrap', { hasText: 'cdi.txt' }).hover()
  await page.getByRole('button', { name: 'Déplacer cdi.txt' }).click()
  await page.getByRole('combobox', { name: 'Déplacer vers' }).selectOption({ label: 'Politiques RH (racine)' })
  await expect(page.getByRole('button', { name: 'Ouvrir cdi.txt' })).toHaveCount(0)
  expect(api.kbCalls).toContain('move:cdi.txt:root')
  await page.getByRole('navigation', { name: 'Emplacement' }).getByRole('button', { name: 'Politiques RH' }).click()
  await expect(page.getByRole('button', { name: 'Ouvrir cdi.txt' })).toBeVisible()

  // Retour à la liste : la base y figure avec son nombre de documents.
  await page.getByRole('button', { name: 'Bases de connaissances' }).click()
  await expect(page.locator('.list-row-wrap', { hasText: 'Politiques RH' })).toContainText('1 document')
})

test('rattacher des bases à un agent ; une base en lecture seule n’est pas proposée ; ouvrir depuis l’agent', async ({ page }) => {
  const agent = fakeAgent('Assistant RH', { mine: true })
  const api = await mockApi(page, {
    agents: [agent],
    knowledgeBases: [
      { id: 'kb-rh', name: 'Politiques RH' },
      { id: 'kb-lu', name: 'Procédures DSI', access: 'view', mine: false },
    ],
  })
  await page.goto('/')
  await openSpace(page, 'Agents')
  await page.locator('.list-row-wrap', { hasText: 'Assistant RH' }).hover()
  await page.getByRole('button', { name: /Modifier Assistant RH/ }).click()

  const section = page.getByRole('region', { name: 'Bases de connaissances' })
  await expect(section).toContainText('Aucune base')
  await section.getByRole('button', { name: 'Rattacher une base' }).click()
  const choice = section.getByRole('combobox', { name: 'Rattacher une base' })
  // Seulement les bases qu'on peut modifier : celle partagée en lecture n'est pas proposée.
  await expect(choice.locator('option', { hasText: 'Procédures DSI' })).toHaveCount(0)
  await choice.selectOption({ label: 'Politiques RH' })
  await expect(section.locator('.list-row-wrap', { hasText: 'Politiques RH' })).toBeVisible()
  expect(api.kbCalls).toContain(`link:agents:${agent.id}:1`)

  // Ouvrir la base depuis l'agent : l'espace Connaissances s'ouvre sur elle.
  await section.getByRole('button', { name: 'Ouvrir Politiques RH dans Connaissances' }).first().click()
  await expect(page.locator('.project-view-head strong')).toHaveText('Politiques RH')
})

test('base partagée en lecture : consultable, sans actions de modification', async ({ page }) => {
  await mockApi(page, { knowledgeBases: [{ id: 'kb-lu', name: 'Procédures DSI', access: 'view', mine: false }] })
  await page.goto('/')
  await openSpace(page, 'Connaissances')
  await expect(page.getByRole('region', { name: 'Partagées avec moi' })).toContainText('Procédures DSI')
  await page.getByRole('button', { name: 'Procédures DSI' }).click()
  await expect(page.getByText('Tu consultes cette base')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nouveau dossier' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Supprimer la base' })).toHaveCount(0)
})
