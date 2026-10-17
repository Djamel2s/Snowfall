import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : 👍 / 👎 sous une réponse ; après 👎, un commentaire facultatif.

test('noter une réponse : 👎, commentaire, puis retirer la note', async ({ page }, info) => {
  const api = await mockApi(page, { answer: 'Le plafond repas à l’étranger est de 25 €.' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Plafond repas à l’étranger ?')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Le plafond repas à l’étranger est de 25 €.')).toBeVisible()

  const down = page.getByRole('button', { name: 'Mauvaise réponse' })
  await down.click()
  await expect(down).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('textbox', { name: /Qu’est-ce qui n’allait pas/ }).fill('C’est 40 € à l’étranger')
  await page.screenshot({ path: info.outputPath('feedback.png') })
  await page.getByRole('button', { name: 'Envoyer le commentaire' }).click()
  await expect(page.getByRole('textbox', { name: /Qu’est-ce qui n’allait pas/ })).toHaveCount(0)

  await down.click()
  await expect(down).toHaveAttribute('aria-pressed', 'false')
  expect(api.feedbackCalls.map(({ rating, comment }) => [rating, comment ?? null])).toEqual([
    ['down', null],
    ['down', 'C’est 40 € à l’étranger'],
    [null, null],
  ])
  expect(api.unknown).toEqual([])
})
