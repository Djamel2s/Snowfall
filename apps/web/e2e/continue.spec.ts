import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : une réponse coupée (longueur maximale) se continue d'un clic ;
// la suite s'ajoute au même message, sans nouvelle version.

test('réponse inachevée : « Continuer » ajoute la suite au même message', async ({ page }, info) => {
  const api = await mockApi(page, { answer: 'Les trois étapes sont : 1. lire, 2. ', continuation: 'comprendre, 3. agir.' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Quelles étapes ?')
  await page.keyboard.press('Enter')

  const answer = page.locator('.message-assistant').last()
  await expect(answer).toContainText('1. lire, 2.')
  const resume = page.getByRole('button', { name: 'Continuer la réponse' })
  await expect(resume).toBeVisible()
  await resume.click()

  await expect(page.locator('.message-assistant').last()).toContainText('1. lire, 2. comprendre, 3. agir.')
  await expect(page.locator('.message-assistant')).toHaveCount(1)
  await expect(resume).toHaveCount(0)
  expect(api.continueCalls).toHaveLength(1)
  await page.screenshot({ path: info.outputPath('continuer.png') })
})

test('réponse complète : pas de bouton « Continuer »', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Bonjour')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant .markdown')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continuer la réponse' })).toHaveCount(0)
})
