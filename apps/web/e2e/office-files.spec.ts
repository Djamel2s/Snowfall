import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : l'agent a produit une présentation, un rapport, un classeur et un
// PDF ; chacun se reconnaît à son icône et à son format, et se télécharge.

test('documents produits : format reconnu (PowerPoint, Word, Excel, PDF), taille, téléchargement', async ({ page }) => {
  await mockApi(page, { officeAnswer: true })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Fais-moi le bilan en présentation, rapport et classeur')
  await page.keyboard.press('Enter')
  const files = page.getByLabel('Fichiers produits')
  for (const [name, label] of [['bilan.pptx', 'PowerPoint · 37 Ko'], ['audit.docx', 'Word · 40 Ko'], ['ventes.xlsx', 'Excel · 9 Ko'], ['bilan.pdf', 'PDF · 51 Ko']]) {
    const chip = files.getByRole('button', { name: new RegExp(name.replace('.', '[.]')) })
    await expect(chip).toContainText(label)
  }
  await expect(files.locator('.message-file.pptx')).toHaveCount(1)
})
