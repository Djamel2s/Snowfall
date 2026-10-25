import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : comparer deux modèles — la même question posée à un autre modèle,
// les deux réponses côte à côte ; on garde l'une, l'autre reste une version.

async function askAndCompare(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Résume le contrat')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant .markdown')).toContainText('Réponse de mistral-small.')
  await page.getByRole('button', { name: 'Comparer avec un autre modèle' }).click()
  await page.getByRole('menuitem', { name: 'mistral-large' }).click()
}

test('côte à côte, puis garder la réponse du modèle comparé', async ({ page }, info) => {
  const api = await mockApi(page, { answer: 'Réponse de mistral-small.', compareAnswer: 'Réponse de mistral-large.' })
  await askAndCompare(page)
  const pair = page.getByRole('group', { name: 'Comparaison' })
  await expect(pair.getByRole('region', { name: 'mistral-small' })).toContainText('Réponse de mistral-small.')
  await expect(pair.getByRole('region', { name: 'mistral-large' })).toContainText('Réponse de mistral-large.')
  expect(api.regenerateCalls).toEqual([{ model: { provider: 'mistral', model: 'mistral-large-latest' } }])
  await page.screenshot({ path: info.outputPath('comparaison.png') })

  await pair.getByRole('region', { name: 'mistral-large' }).getByRole('button', { name: 'Garder celle-ci' }).click()
  await expect(pair).toHaveCount(0)
  await expect(page.locator('.message-assistant').last()).toContainText('Réponse de mistral-large.')
  expect(api.branchCalls).toEqual([])
})

test('garder la réponse d’avant : sa version redevient celle affichée', async ({ page }) => {
  const api = await mockApi(page, { answer: 'Réponse de mistral-small.', compareAnswer: 'Réponse de mistral-large.' })
  await askAndCompare(page)
  const pair = page.getByRole('group', { name: 'Comparaison' })
  await pair.getByRole('region', { name: 'mistral-small' }).getByRole('button', { name: 'Garder celle-ci' }).click()
  await expect(pair).toHaveCount(0)
  await expect(page.locator('.message-assistant').last()).toContainText('Réponse de mistral-small.')
  expect(api.branchCalls).toHaveLength(1)
})
