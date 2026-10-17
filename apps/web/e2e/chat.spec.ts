import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : poser une question, lire la réponse en flux ; un artifact seul
// s'ouvre de lui-même, sans exécuter de script, et se télécharge.

const diagram = 'Voici le schéma :\n\n```mermaid\nflowchart LR\n  A["Demande"] --> B["Validation (manager)"]\n```'

test('question → réponse en Markdown, enregistrée dans la conversation', async ({ page }) => {
  const api = await mockApi(page, { answer: 'Le télétravail est possible **trois jours** par semaine [1].' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Combien de jours de télétravail ?')
  await page.keyboard.press('Enter')
  await expect(page.locator('.markdown strong', { hasText: 'trois jours' })).toBeVisible()
  await expect(page.getByText('Combien de jours de télétravail ?')).toBeVisible()
  expect(api.unknown).toEqual([])
})

test('artifact seul : carte repliée, panneau ouvert d’office en aperçu, téléchargeable', async ({ page }, info) => {
  await mockApi(page, { answer: diagram })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Fais un schéma de la validation des congés')
  await page.keyboard.press('Enter')

  // Le code n'est pas affiché (la question ne le demandait pas) : une carte à la place.
  await expect(page.locator('.md-artifact')).toBeVisible()
  await expect(page.locator('.md-code pre')).toHaveCount(0)

  // Le panneau s'ouvre seul, en « Aperçu », avec un cadre isolé sans same-origin.
  const panel = page.locator('.artifact-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: /Aperçu/ })).toHaveAttribute('aria-selected', 'true')
  const frame = panel.locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  // Le diagramme est rendu dans le cadre.
  await expect(page.frameLocator('.artifact-panel iframe').locator('svg#artifact-diagram')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: info.outputPath('artifact.png') })

  const download = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Télécharger' }).click()
  expect((await download).suggestedFilename()).toBe('diagramme.svg')

  // Le code reste accessible à la demande (sur mobile, le panneau plein écran se ferme d'abord).
  await panel.getByRole('button', { name: 'Fermer' }).click()
  await expect(panel).toHaveCount(0)
  await page.locator('.md-artifact-code').click()
  await expect(page.locator('.md-code pre')).toContainText('flowchart LR')
})

test('question qui demande le code : bloc déplié d’emblée', async ({ page }) => {
  await mockApi(page, { answer: diagram })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Donne-moi le code mermaid du schéma')
  await page.keyboard.press('Enter')
  await expect(page.locator('.md-code pre')).toContainText('flowchart LR')
})
