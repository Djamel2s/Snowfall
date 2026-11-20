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
    // Document avec aperçu : la carte ouvre l'aperçu ; « Télécharger » reste à droite.
    await expect(files.getByRole('button', { name: `Aperçu de ${name}` })).toContainText(label)
    await expect(files.getByRole('button', { name: `Télécharger ${name}` })).toBeVisible()
  }
  await expect(files.locator('.message-file.pptx')).toHaveCount(1)
})

test('fichier avec des chiffres absents des sources : la personne voit lesquels vérifier', async ({ page }, info) => {
  await mockApi(page, { officeAnswer: true })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Fais-moi le rapport d’audit')
  await page.keyboard.press('Enter')
  const files = page.getByLabel('Fichiers produits')
  const note = files.getByRole('note')
  // Un seul avertissement, sous le bon fichier ; les autres n'en ont pas.
  await expect(note).toHaveCount(1)
  await expect(note).toHaveText('Chiffres à vérifier : 4 h · 25,8 %')
  await expect(files.locator('.message-file-checked')).toContainText('audit.docx')
  await expect(note).toHaveAttribute('title', /vérifie-les avant d’utiliser le document/)
  await files.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('chiffres-a-verifier.png') })
})

test('aperçu d’un document produit : pages en images dans le panneau ; sinon, il dit pourquoi', async ({ page }, info) => {
  const api = await mockApi(page, { officeAnswer: true })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Fais-moi le rapport d’audit')
  await page.keyboard.press('Enter')
  const files = page.getByLabel('Fichiers produits')
  // Les documents Office et PDF s'ouvrent en aperçu d'un clic sur leur carte ; aucun bouton « œil ».
  await expect(files.getByRole('button', { name: /^Aperçu de / })).toHaveCount(4)
  await files.getByText('audit.docx').click()

  const panel = page.getByRole('complementary', { name: 'Aperçu · audit.docx' })
  await expect(panel.getByRole('img', { name: 'Page 1 sur 3' })).toBeVisible()
  await expect(panel.getByRole('img')).toHaveCount(2)
  await expect(panel).toContainText('2 premières pages sur 3')
  // L'avertissement de fidélité suit le document dans l'aperçu.
  await expect(panel.getByRole('note')).toContainText('Chiffres à vérifier : 4 h · 25,8 %')
  // Aucun document chargé dans un cadre : seulement des images.
  await expect(panel.locator('iframe, object, embed')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('apercu-document.png') })
  // Fermer (sur téléphone, le panneau couvre la conversation).
  await panel.getByRole('button', { name: 'Fermer' }).click()
  await expect(panel).toHaveCount(0)

  // Service absent : le panneau le dit, le téléchargement reste là.
  await files.getByRole('button', { name: 'Aperçu de bilan.pdf' }).click()
  const pdf = page.getByRole('complementary', { name: 'Aperçu · bilan.pdf' })
  await expect(pdf.getByRole('alert')).toContainText('Aperçu indisponible')
  await expect(pdf.getByRole('button', { name: 'Télécharger bilan.pdf' })).toBeVisible()
  await pdf.getByRole('button', { name: 'Fermer' }).click()
  await expect(pdf).toHaveCount(0)
  // En développement, React lance l'effet deux fois (mode strict) : un appel par document ouvert.
  expect([...new Set(api.previewCalls)]).toEqual(['doc-audit.docx', 'doc-bilan.pdf'])
})
