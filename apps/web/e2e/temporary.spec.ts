import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : activer la conversation temporaire, échanger, vérifier qu'elle
// n'entre pas dans l'historique et qu'elle ne se partage pas.

test('conversation temporaire : bandeau, absente de l’historique, pas de partage', async ({ page }, info) => {
  const api = await mockApi(page, { answer: 'Réponse éphémère.' })
  await page.goto('/')
  const composer = page.getByPlaceholder(/Posez votre question/)
  await composer.waitFor()

  const toggle = page.getByRole('button', { name: 'Conversation temporaire' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText(/absente de l’historique, effacée sous 24 h/)).toBeVisible()

  const created = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/conversations'))
  await composer.fill('Note privée')
  await page.keyboard.press('Enter')
  expect((await created).postDataJSON()).toEqual({ temporary: true })
  await expect(page.getByText('Réponse éphémère.')).toBeVisible()
  await expect(page.locator('.chat-temporary-badge')).toBeVisible()
  await page.screenshot({ path: info.outputPath('temporaire.png') })

  // Le menu propose l'export mais pas le partage.
  await page.getByRole('button', { name: 'Actions de la conversation' }).click()
  await expect(page.getByRole('button', { name: 'Créer et copier le lien' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Historique : rien.
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await expect(page.locator('.sidebar').getByText('Note privée')).toHaveCount(0)
  expect(api.unknown).toEqual([])
})
