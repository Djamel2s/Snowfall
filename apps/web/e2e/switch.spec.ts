import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : changer d'agent ou de modèle en cours de conversation, depuis
// l'en-tête ; chaque réponse garde le nom de qui l'a écrite.

test('changer d’agent après le premier message ; les réponses gardent leur auteur', async ({ page }, info) => {
  await mockApi(page, { agents: [fakeAgent('Juriste', { mine: true })], answer: 'Réponse.' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Première question')
  await page.keyboard.press('Enter')
  const authors = page.locator('.message-assistant .message-author')
  await expect(authors).toHaveCount(1)
  const first = await authors.nth(0).innerText()

  // L'en-tête propose désormais de changer.
  const chip = page.locator('.responder-chip-button')
  await chip.click()
  await page.getByRole('option', { name: /Juriste/ }).click()
  await expect(chip).toContainText('Juriste')
  await page.getByPlaceholder(/Posez votre question/).fill('Deuxième question')
  await page.keyboard.press('Enter')
  await expect(authors).toHaveCount(2)
  await expect(authors.nth(0)).toHaveText(first)
  await expect(authors.nth(1)).toHaveText('Juriste')
  await page.screenshot({ path: info.outputPath('changement.png') })
})
