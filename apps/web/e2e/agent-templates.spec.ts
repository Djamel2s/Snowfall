import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : catalogue d'agents prêts à l'emploi — fiche (ce qu'il fait, ses
// limites, ses compétences, ce qu'il faut lui donner), installation, studio ouvert.

test('catalogue : fiche de l’Assistant RH, installation, studio ouvert pour ses documents', async ({ page }, info) => {
  const api = await mockApi(page)
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  // Le catalogue est une section de la liste des agents, comme « Mes agents ».
  await expect(page.getByRole('region', { name: 'Catalogue' })).toBeVisible()

  await expect(page.getByRole('button', { name: 'Voir Juriste contrats' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Voir DPO / RGPD' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('catalogue.png') })
  await page.getByRole('button', { name: 'Voir Assistant RH' }).click()

  const detail = page.getByRole('region', { name: 'Assistant RH' })
  await expect(detail.getByRole('heading', { name: 'Ce qu’il fait'.replace('’', "'") })).toBeVisible()
  await expect(detail).toContainText('Ne tranche aucun cas individuel')
  await expect(detail).toContainText('Rédiger une offre d’emploi'.replace('’', "'"))
  await expect(detail).toContainText('Règlement intérieur')
  await detail.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('fiche.png') })

  await detail.getByRole('button', { name: 'Installer cet agent' }).click()
  expect(api.templateInstalls).toEqual(['assistant-rh'])
  // Le studio de l'agent installé s'ouvre : on y ajoute ses documents.
  await expect(page.getByRole('form', { name: 'Modifier l’agent' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Nom' })).toHaveValue('Assistant RH')
})
