import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : réglages propres à une conversation (créativité, longueur,
// consignes) et préréglages réappliqués en un clic — dans la barre latérale.

async function startConversation(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Bonjour')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant .markdown')).toBeVisible()
}

test('réglages de la conversation, puis préréglage enregistré et réappliqué', async ({ page }, info) => {
  const api = await mockApi(page)
  await startConversation(page)

  await page.getByRole('button', { name: 'Réglages de la conversation' }).click()
  const card = page.getByRole('region', { name: 'Réponses' })
  await expect(card).toBeVisible()
  const save = card.getByRole('button', { name: 'Enregistrer' })
  await expect(save).toBeDisabled()

  await card.getByRole('radiogroup', { name: 'Créativité' }).getByRole('radio', { name: 'Précise' }).click()
  await card.getByRole('radiogroup', { name: 'Longueur' }).getByRole('radio', { name: 'Concise' }).click()
  await card.getByRole('textbox', { name: 'Consignes pour cette conversation' }).fill('Cite les articles.')
  await save.click()
  await expect(card.getByRole('button', { name: 'Enregistré' })).toBeVisible()
  expect(api.conversationPatches.at(-1)).toEqual({ settings: { creativity: 'precise', length: 'concise', instructions: 'Cite les articles.' } })
  await page.screenshot({ path: info.outputPath('reglages.png') })

  // Préréglage : les réglages en cours, sous un nom.
  const presets = page.getByRole('region', { name: 'Préréglages' })
  await presets.getByRole('textbox', { name: 'Nom du préréglage' }).fill('Juridique')
  await presets.getByRole('button', { name: 'Ajouter' }).click()
  await expect(presets.getByRole('button', { name: 'Juridique', exact: true })).toBeVisible()
  expect(api.presets[0]).toMatchObject({ name: 'Juridique', settings: { creativity: 'precise', length: 'concise', instructions: 'Cite les articles.' } })

  // On change, puis le préréglage remet tout d'un clic.
  await card.getByRole('radiogroup', { name: 'Créativité' }).getByRole('radio', { name: 'Créative' }).click()
  await card.getByRole('textbox', { name: 'Consignes pour cette conversation' }).fill('')
  await save.click()
  await expect.poll(() => api.conversationPatches.at(-1)).toEqual({ settings: { creativity: 'creative', length: 'concise' } })
  await presets.getByRole('button', { name: 'Juridique', exact: true }).click()
  await expect.poll(() => api.conversationPatches.at(-1)).toEqual({ settings: { creativity: 'precise', length: 'concise', instructions: 'Cite les articles.' } })
  await expect(card.getByRole('radiogroup', { name: 'Créativité' }).getByRole('radio', { name: 'Précise' })).toHaveAttribute('aria-checked', 'true')

  // Supprimer un préréglage.
  await presets.getByRole('button', { name: 'Supprimer Juridique' }).click()
  await expect(presets.getByRole('button', { name: 'Juridique', exact: true })).toHaveCount(0)
})

test('consignes de conversation refusées par le serveur : l’erreur s’affiche, rien n’est retenu', async ({ page }) => {
  await mockApi(page)
  await startConversation(page)
  await page.getByRole('button', { name: 'Réglages de la conversation' }).click()
  const card = page.getByRole('region', { name: 'Réponses' })
  await card.getByRole('textbox', { name: 'Consignes pour cette conversation' }).fill('Je suis diabétique.')
  await card.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('alert')).toContainText('Retirez les données sensibles')
  await expect(page.getByRole('button', { name: 'Réglages de la conversation' })).not.toHaveClass(/has-settings/)
})
