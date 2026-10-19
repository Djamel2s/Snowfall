import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : une donnée sensible dans un message. Avec un modèle local, la
// conversation y bascule et le dit ; sans, rien n'est envoyé et l'on sait pourquoi.

const message = 'Mon numéro de sécu est 1 85 05 78 006 084 91, je change d’adresse.'

async function send(page: import('@playwright/test').Page, text: string) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill(text)
  await page.keyboard.press('Enter')
}

test('modèle local disponible : la conversation reste en local et le dit', async ({ page }, info) => {
  const api = await mockApi(page, { sensitive: 'local', answer: 'C’est noté.' })
  await send(page, message)
  await expect(page.getByText('C’est noté.')).toBeVisible()
  await expect(page.getByText('Données sensibles détectées : cette conversation reste sur un modèle local.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('sensible.png') })
  expect(api.unknown).toEqual([])
})

test('aucun modèle local : refus clair, catégorie sans la valeur', async ({ page }) => {
  await mockApi(page, { sensitive: 'blocked' })
  await send(page, message)
  const alert = page.getByRole('alert').filter({ hasText: 'Données sensibles détectées' })
  await expect(alert).toContainText('n° de sécurité sociale')
  await expect(alert).toContainText('rien n’a été envoyé')
  await expect(alert).not.toContainText('006 084')
})
