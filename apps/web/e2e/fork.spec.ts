import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : bifurquer depuis une réponse — une nouvelle conversation reprend
// l'échange jusque-là et s'ouvre ; l'originale reste dans l'historique.

test('bifurquer depuis la première réponse : la copie s’ouvre, l’originale reste', async ({ page }, info) => {
  const api = await mockApi(page, { answer: 'Réponse.' })
  await page.goto('/')
  const composer = page.getByPlaceholder(/Posez votre question/)
  await composer.fill('Première question')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant')).toHaveCount(1)
  await composer.fill('Seconde question')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant')).toHaveCount(2)

  await page.locator('.message-assistant').first().getByRole('button', { name: 'Bifurquer ici (nouvelle conversation)' }).click()
  await expect.poll(() => api.forks.length).toBe(1)
  // La copie : seulement le premier échange.
  await expect(page.locator('.message-user')).toHaveCount(1)
  await expect(page.locator('.message-user')).toContainText('Première question')
  await expect(page.locator('.message-assistant')).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('bifurcation.png') })

  // L'originale, toujours là avec ses deux échanges.
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await expect(page.locator('.conversation-list').getByText('Première question')).toHaveCount(2)
})
