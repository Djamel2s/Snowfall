import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : créer un prompt à variables dans la barre latérale, le retrouver
// avec « / » dans la saisie, renseigner la variable, obtenir le texte complet.

test('prompts : création, « / » dans la saisie, variables renseignées', async ({ page }, info) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  const mobile = await menu.isVisible().catch(() => false)
  if (mobile) await menu.click()
  await page.getByRole('button', { name: 'Prompts', exact: true }).first().click()
  await expect(page.getByText('Résumé')).toBeVisible()

  await page.getByRole('button', { name: 'Nouveau prompt' }).click()
  await page.getByLabel('Nom', { exact: true }).fill('Traduction')
  await page.getByLabel('Texte du prompt').fill('Traduis en {{langue}} : {{texte}}')
  await expect(page.getByText('Variables : langue, texte')).toBeVisible()
  const created = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/prompts'))
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  expect((await created).postDataJSON()).toEqual({ name: 'Traduction', content: 'Traduis en {{langue}} : {{texte}}', shared: false })
  await page.screenshot({ path: info.outputPath('bibliotheque.png') })
  if (mobile) await page.mouse.click((page.viewportSize()?.width ?? 400) - 10, 300)

  const composer = page.getByPlaceholder(/Posez votre question/)
  await composer.click()
  await composer.fill('/tra')
  await expect(page.getByRole('option', { name: /Traduction/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Résumé/ })).toBeHidden()
  await page.screenshot({ path: info.outputPath('slash.png') })
  await page.keyboard.press('Enter')

  await page.getByRole('form', { name: 'Variables de Traduction' }).getByLabel('langue').fill('anglais')
  await page.getByLabel('texte').fill('Bonjour')
  await page.getByRole('button', { name: 'Insérer' }).click()
  await expect(composer).toHaveValue('Traduis en anglais : Bonjour')
})
