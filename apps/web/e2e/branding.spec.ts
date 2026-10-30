import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { mockApi } from './mock-api'

// Parcours : l'administrateur donne son identité à l'outil (Administration ›
// Identité). Le logo change partout ; sans logo, celui de Snowfall, recoloré.

const logoFile = fileURLToPath(new URL('../public/logo.png', import.meta.url))

async function open(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (!(await page.locator('.sidebar.sidebar-open').count()) && (await menu.isVisible().catch(() => false))) await menu.click()
  await page.getByRole('button', { name, exact: true }).first().click()
}

const sources = (page: Page) => page.locator('img.snowfall-logo, img.user-avatar-logo, img.snowfall-sun').evaluateAll((images) => images.map((image) => (image as HTMLImageElement).getAttribute('src')))

test('identité : nom de l’organisation, couleur du logo, logo importé partout, puis retour au logo Snowfall', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  // Le nom de l'organisation, discret, à côté du produit.
  await open(page, 'Conversations')
  await expect(page.locator('.brand-org')).toHaveText('Polaris')

  await open(page, 'Administration')
  await page.getByRole('tab', { name: 'Identité' }).click()
  const card = page.getByRole('region', { name: 'Identité de l’organisation' })
  // Rouge : toute l'interface passe au rouge (ses nuances gardées) ; le logo par défaut suit, partout et dans l'onglet.
  const accentText = () => page.locator('.new-chat-button, .settings-save').first().evaluate((element) => getComputedStyle(element).backgroundImage + getComputedStyle(element).backgroundColor)
  const blue = await accentText()
  await card.getByRole('radio', { name: '#e5484d' }).click()
  await expect.poll(() => api.brandingCalls).toEqual(['color:#e5484d'])
  await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-accent'))).toBe(true)
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent-shift'))).toMatch(/^148\.\ddeg$/)
  await expect.poll(accentText).not.toBe(blue)
  await expect.poll(async () => (await sources(page)).every((src) => src?.startsWith('data:image/png'))).toBe(true)
  await expect.poll(() => page.locator('link[rel="icon"]').getAttribute('href')).toMatch(/^data:image\/png/)
  await page.screenshot({ path: info.outputPath('rouge.png'), fullPage: true })

  // Logo importé : redimensionné dans le navigateur, puis affiché partout depuis l'API.
  await card.getByLabel('Importer un logo').setInputFiles(logoFile)
  await expect.poll(() => api.brandingCalls.at(-1) ?? '').toMatch(/^upload:image\/png:\d+$/)
  await expect.poll(async () => (await sources(page)).every((src) => src?.startsWith('/api/branding/logo?v='))).toBe(true)
  // La couleur de l'interface reste réglable avec un logo importé.
  await expect(card.getByRole('radiogroup', { name: 'Couleur de l’interface' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('importe.png'), fullPage: true })

  // Supprimer (deux clics) : retour au logo Snowfall, dans la couleur choisie.
  await card.getByRole('button', { name: 'Revenir au logo Snowfall' }).click()
  await card.getByRole('button', { name: 'Cliquer encore pour confirmer' }).click()
  await expect.poll(() => api.brandingCalls.at(-1)).toBe('delete')
  await card.getByRole('button', { name: 'Revenir au bleu' }).click()
  await expect.poll(async () => (await sources(page)).every((src) => src === '/logo.png')).toBe(true)
  // Bleu : plus aucune surcharge, l'interface d'origine.
  await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-accent'))).toBe(false)
  await expect.poll(accentText).toBe(blue)
  expect(api.unknown).toEqual([])
})

test('membre : voit l’identité, sans Administration pour la changer', async ({ page }) => {
  await mockApi(page, { role: 'member' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  await open(page, 'Conversations')
  await expect(page.locator('.brand-org')).toHaveText('Polaris')
  await expect(page.getByRole('button', { name: 'Administration' })).toHaveCount(0)
})
