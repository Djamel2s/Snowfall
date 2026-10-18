import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : dicter une question (micro simulé par le navigateur de test), puis
// faire lire la réponse. Sans voix installée, aucun bouton n'apparaît.

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } })

test('dictée : la voix devient du texte dans la saisie ; lecture de la réponse', async ({ page }) => {
  const api = await mockApi(page, { voice: true, answer: '**30 jours** de congés par an.' })
  await page.goto('/')
  const composer = page.getByPlaceholder(/Posez votre question/)
  await page.getByRole('button', { name: 'Dicter' }).click()
  await expect(page.getByRole('button', { name: 'Arrêter la dictée' })).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: 'Arrêter la dictée' }).click()
  await expect(composer).toHaveValue('Combien de jours de congés ?')
  expect(api.audioCalls[0]!.size).toBeGreaterThan(0)
  expect(['audio/webm', 'audio/ogg', 'audio/mp4']).toContain(api.audioCalls[0]!.type)

  await page.keyboard.press('Enter')
  await expect(page.getByText('30 jours')).toBeVisible()
  await page.getByRole('button', { name: 'Lire à voix haute' }).click()
  await expect.poll(() => api.speechCalls).toEqual(['**30 jours** de congés par an.'])
})

test('sans voix installée : ni micro ni lecture', async ({ page }) => {
  await mockApi(page, { answer: 'Bonjour.' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Salut')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Bonjour.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Dicter' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Lire à voix haute' })).toHaveCount(0)
})
