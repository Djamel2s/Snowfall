import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : une question modifiée garde son ancienne version ; ‹ 1/2 › permet
// de revenir à la version d'origine et à sa réponse.

const at = '2026-10-17T08:00:00.000Z'
const q1 = { id: 'm-q1', role: 'user', content: 'Combien de congés ?', createdAt: at }
const r1 = { id: 'm-r1', role: 'assistant', content: 'Trente jours par an.', createdAt: at }
const q2 = { id: 'm-q2', role: 'user', content: 'Et pour un stagiaire ?', createdAt: at, branch: { index: 0, count: 2, siblings: ['m-q2', 'm-q2b'] } }
const r2 = { id: 'm-r2', role: 'assistant', content: 'Les stagiaires ont droit à 2,5 jours par mois.', createdAt: at }
const q2b = { id: 'm-q2b', role: 'user', content: 'Et pour un CDD ?', createdAt: at, branch: { index: 1, count: 2, siblings: ['m-q2', 'm-q2b'] } }
const r2b = { id: 'm-r2b', role: 'assistant', content: 'Comme un CDI, au prorata.', createdAt: at }

test('versions d’un message : ‹ 2/2 › → version d’origine avec sa réponse', async ({ page }) => {
  const api = await mockApi(page, { branches: { title: 'Congés', shown: [q1, r1, q2b, r2b], other: [q1, r1, q2, r2] } })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Congés' }).first().click()

  const versions = page.getByRole('group', { name: 'Versions' })
  await expect(versions).toHaveCount(1)
  await expect(versions).toContainText('2/2')
  await expect(page.getByText('Comme un CDI, au prorata.')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('versions.png') })

  const switched = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/branch'))
  await versions.getByRole('button', { name: 'Version précédente' }).click()
  expect((await switched).postDataJSON()).toEqual({ messageId: 'm-q2' })
  await expect(page.getByText('Les stagiaires ont droit à 2,5 jours par mois.')).toBeVisible()
  await expect(page.getByText('Comme un CDI, au prorata.')).toHaveCount(0)
  await expect(versions).toContainText('1/2')
  await expect(versions.getByRole('button', { name: 'Version précédente' })).toBeDisabled()
  expect(api.unknown).toEqual([])
})
