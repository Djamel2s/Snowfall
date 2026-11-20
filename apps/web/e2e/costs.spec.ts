import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : un administrateur voit ce que l'organisation dépense en euros,
// saisit le tarif d'un modèle qui n'en a pas, fixe des budgets et des plafonds ;
// un membre voit ses propres dépenses face à son budget.

async function openAdmin(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Administration' }).first().click()
}

test('coûts : dépenses par modèle, tarif manquant signalé puis saisi, budgets et plafonds enregistrés', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['search_knowledge', 'save_to_knowledge', 'image_generation'] })
  await openAdmin(page)

  // Pilotage : les euros des six derniers mois, face au budget.
  const pilot = page.getByRole('region', { name: 'Coûts', exact: true })
  await expect(pilot).toContainText(/75,00\s€ \/ 100,00\s€/)
  await expect(pilot).toContainText('1 modèle sans tarif')
  await expect(pilot.getByRole('img', { name: 'Coûts des six derniers mois' }).locator('span')).toHaveCount(6)

  await page.getByRole('tab', { name: 'Coûts' }).click()
  const month = page.getByRole('region', { name: 'Ce mois-ci' })
  await expect(month).toContainText(/10,60\s€ \/ 100,00\s€/)
  await expect(month).toContainText('Mistral · mistral-large-latest')
  await expect(month).toContainText('sans tarif')
  // Local : gratuit, sans saisie de tarif.
  await expect(month).toContainText('qwen3:8b')
  await expect(page.getByLabel('Local · qwen3:8b · Entrée')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('couts.png'), fullPage: true })

  // Tarif du modèle sans prix, budget par membre, plafond d'images par membre, durée d'une réponse.
  await page.getByLabel('OpenAI · gpt-x · Entrée').fill('2,5')
  await page.getByLabel('OpenAI · gpt-x · Sortie').fill('10')
  await page.getByLabel('Images créées par membre').fill('30')
  await page.getByLabel('Durée au plus (s)').fill('120')
  // Saisi puis enregistré directement, sans quitter le champ.
  await page.getByLabel('Par membre (€)').fill('20')
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('button', { name: 'Enregistré' })).toBeVisible()
  const saved = api.savedSettings.at(-1) as Record<string, unknown> & { prices: { models: Record<string, unknown> } }
  expect(saved.prices.models['openai:gpt-x']).toEqual({ input: 2.5, output: 10 })
  // Les tarifs déjà saisis restent.
  expect(saved.prices.models['mistral:mistral-large-latest']).toEqual({ input: 2, output: 6 })
  expect([saved.memberMonthlyBudget, saved.monthlyBudget, saved.responseMaxSeconds]).toEqual([20, 100, 120])
  expect(saved.memberToolLimits).toEqual({ image: 30 })
  expect(api.unknown).toEqual([])
})

test('membre : ses dépenses face à son budget, ses quotas d’outils ; jamais ceux de l’organisation en euros', async ({ page }) => {
  await mockApi(page, { role: 'member' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Paramètres' }).first().click()
  const usage = page.getByRole('region', { name: 'Consommation' })
  await expect(usage).toContainText('Mes dépenses')
  await expect(usage).toContainText(/3,20\s€ \/ 20,00\s€/)
  await expect(usage).toContainText('Recherches et pages web par membre')
  await expect(usage).toContainText('4 / 50')
  await expect(page.getByRole('tab', { name: 'Coûts' })).toHaveCount(0)
})
