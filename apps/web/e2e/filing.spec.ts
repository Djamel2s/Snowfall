import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : ranger ses conversations — étiquettes (filtre dans l'historique)
// et archive (hors de l'historique, retrouvée dans « Archivées »).

async function ask(page: Page, question: string) {
  await page.getByRole('button', { name: 'Nouvelle conversation' }).first().click()
  await page.getByPlaceholder(/Posez votre question/).fill(question)
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant .markdown')).toBeVisible()
}

async function openSidebar(page: Page) {
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
}

test('étiquette puis filtre ; archive puis retour depuis « Archivées »', async ({ page }, info) => {
  const api = await mockApi(page)
  await page.goto('/')
  await openSidebar(page)
  await ask(page, 'Contrat Durand')
  await openSidebar(page)
  await ask(page, 'Recette de cuisine')

  // Étiquette sur la conversation ouverte (Recette).
  await page.getByRole('button', { name: 'Réglages de la conversation' }).click()
  const filing = page.getByRole('region', { name: 'Rangement' })
  await filing.getByRole('textbox', { name: 'Ajouter une étiquette' }).fill('Perso')
  await filing.getByRole('button', { name: 'Ajouter' }).click()
  await expect(filing.getByText('Perso')).toBeVisible()
  expect(api.conversationPatches.at(-1)).toEqual({ tags: ['Perso'] })
  await page.screenshot({ path: info.outputPath('rangement.png') })

  // Filtre de l'historique par étiquette.
  await filing.locator('..').getByRole('button', { name: 'Fermer' }).click()
  const history = page.locator('.conversation-list')
  await expect(history.getByText('Contrat Durand')).toBeVisible()
  await page.getByRole('group', { name: 'Filtrer par étiquette' }).getByRole('button', { name: 'Perso' }).click()
  await expect(history.getByText('Contrat Durand')).toHaveCount(0)
  await expect(history.getByText('Recette de cuisine')).toBeVisible()
  await page.getByRole('group', { name: 'Filtrer par étiquette' }).getByRole('button', { name: 'Perso' }).click()

  // Archiver depuis le menu de la ligne : disparaît de l'historique.
  await history.getByRole('button', { name: 'Contrat Durand', exact: true }).last().click()
  await page.getByRole('menuitem', { name: 'Archiver' }).click()
  await expect(history.getByText('Contrat Durand')).toHaveCount(0)
  expect(api.conversationPatches.at(-1)).toEqual({ archived: true })

  // « Archivées (1) » : la retrouver, puis la désarchiver.
  await page.getByRole('button', { name: 'Archivées (1)' }).click()
  await expect(history.getByText('Contrat Durand')).toBeVisible()
  await expect(history.getByText('Recette de cuisine')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('archivees.png') })
  await history.getByRole('button', { name: 'Contrat Durand', exact: true }).last().click()
  await page.getByRole('menuitem', { name: 'Désarchiver' }).click()
  await expect(page.getByRole('button', { name: /Archivées/ })).toHaveCount(0)
  await expect(history.getByText('Contrat Durand')).toBeVisible()
})
