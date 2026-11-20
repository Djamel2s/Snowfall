import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : une photo comme icône d'une base de connaissances ou d'un
// connecteur. Choisie dans la fiche, recadrée et réencodée par le navigateur,
// visible dans la liste ; retirée d'un clic. Un membre la voit sans pouvoir la changer.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function openPanel(page: Page, name: string) {
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (!(await page.locator('.sidebar.sidebar-open').count()) && (await menu.isVisible().catch(() => false))) await menu.click()
  await page.getByRole('button', { name, exact: true }).first().click()
}

test('base de connaissances : choisir une photo, la voir dans la liste, la retirer', async ({ page }, info) => {
  const api = await mockApi(page, { knowledgeBases: [{ id: 'kb-rh', name: 'Politiques RH' }] })
  await page.goto('/')
  await openPanel(page, 'Connaissances')
  await page.locator('.list-row-wrap', { hasText: 'Politiques RH' }).getByRole('button').first().click()

  const head = page.locator('.project-view-head')
  await expect(head.getByRole('button', { name: 'Choisir une photo' })).toBeVisible()
  await head.locator('input[type="file"]').setInputFiles({ name: 'equipe.png', mimeType: 'image/png', buffer: PNG })
  // Réencodée dans le navigateur : jamais le fichier d'origine.
  await expect(head.locator('.entity-icon img')).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/)
  const sent = api.kbCalls.find((call) => call.startsWith('update:') && call.includes('"icon"'))
  expect(sent).toMatch(/data:image\/(webp|jpeg)/)
  expect(sent).not.toContain(PNG.toString('base64').slice(0, 40))
  await page.screenshot({ path: info.outputPath('base-photo.png') })

  await page.getByRole('button', { name: 'Bases de connaissances' }).click()
  await expect(page.locator('.list-row-wrap', { hasText: 'Politiques RH' }).locator('.entity-icon img')).toBeVisible()

  await page.locator('.list-row-wrap', { hasText: 'Politiques RH' }).getByRole('button').first().click()
  await head.getByRole('button', { name: 'Retirer la photo' }).click()
  await expect(head.locator('.entity-icon img')).toHaveCount(0)
  expect(api.kbCalls.at(-1)).toBe('update:{"icon":null}')
})

test('connecteur : un administrateur choisit sa photo, visible dans la liste', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  api.mcpServers.push({ id: 'mcp-intra', name: 'Intranet', status: 'approved', auth: 'token', kind: 'mcp', url: 'https://intranet.example/mcp', tools: [{ name: 'search', title: null, access: 'read' }] })
  await page.goto('/')
  await openPanel(page, 'Connecteurs')
  const added = page.getByRole('region', { name: "Connecteurs de l'organisation" })
  // Sans photo : l'initiale.
  await expect(added.locator('.connector-logo svg').first()).toBeVisible()
  await added.getByRole('button', { name: /Intranet/ }).first().click()

  const card = page.getByRole('region', { name: 'Intranet', exact: true })
  await card.locator('.icon-picker input[type="file"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG })
  await expect(card.locator('.connector-detail-head .entity-icon img')).toHaveAttribute('src', /^data:image\/(webp|jpeg);base64,/)
  expect(api.mcpServers[0]?.icon).toMatch(/^data:image\/(webp|jpeg);base64,/)
  await page.screenshot({ path: info.outputPath('connecteur-photo.png') })

  await card.getByRole('button', { name: 'Connecteurs' }).click()
  await expect(added.locator('.connector-logo img')).toBeVisible()
})

test('connecteur vu par un membre : la photo, sans bouton pour la changer', async ({ page }) => {
  const api = await mockApi(page, { role: 'member', platformTools: ['mcp'] })
  const icon = `data:image/png;base64,${PNG.toString('base64')}`
  api.mcpServers.push({ id: 'mcp-intra', name: 'Intranet', status: 'approved', auth: 'token', kind: 'mcp', url: 'https://intranet.example/mcp', tools: [{ name: 'search', title: null, access: 'read' }], icon })
  await page.goto('/')
  await openPanel(page, 'Connecteurs')
  const added = page.getByRole('region', { name: "Connecteurs de l'organisation" })
  await expect(added.locator('.connector-logo img')).toHaveAttribute('src', icon)
  await added.getByRole('button', { name: /Intranet/ }).first().click()
  const card = page.getByRole('region', { name: 'Intranet', exact: true })
  await expect(card.locator('.connector-logo img')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Choisir une photo' })).toHaveCount(0)
})
