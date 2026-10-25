import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : thème (système, sombre, clair) et instructions personnalisées.
// Le fichier passe en dernier (zz-) : il change le thème de la page.

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/')
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Paramètres' }).first().click()
}

test('thème : « Clair » s’applique tout de suite et est enregistré', async ({ page }, info) => {
  const api = await mockApi(page)
  await openSettings(page)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('radiogroup', { name: 'Thème' }).getByRole('radio', { name: 'Clair' }).click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => api.savedPreferences.at(-1)?.theme).toBe('light')
  // Le fond de page change vraiment (pas seulement l'attribut).
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(background).not.toBe('rgb(8, 14, 25)')
  await page.screenshot({ path: info.outputPath('clair.png') })
})

test('thème « Système » : suit la préférence du navigateur', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await mockApi(page, { theme: 'system' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('instructions : enregistrées à la demande ; une donnée sensible est refusée', async ({ page }) => {
  const api = await mockApi(page)
  await openSettings(page)
  const card = page.getByRole('region', { name: 'Instructions personnalisées' })
  const box = card.getByRole('textbox', { name: 'Instructions personnalisées' })
  const save = card.getByRole('button', { name: 'Enregistrer' })
  await expect(save).toBeDisabled()

  await box.fill('Je suis diabétique, adapte les menus.')
  await save.click()
  await expect(page.getByRole('alert')).toContainText('Retirez les données sensibles')
  expect(api.savedPreferences.some((item) => item.instructions?.includes('diabétique'))).toBe(false)

  await box.fill('Réponds en points courts.')
  await save.click()
  await expect.poll(() => api.savedPreferences.at(-1)?.instructions).toBe('Réponds en points courts.')
  await expect(card.getByText('Enregistré')).toBeVisible()
})
