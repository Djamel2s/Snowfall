import { expect, test, type Page } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : créer une compétence (description, instructions, fichier de
// référence), puis la confier à un agent depuis son studio.

async function openSidebar(page: Page) {
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
}

test('compétence créée avec un fichier, puis confiée à un agent', async ({ page }, info) => {
  const api = await mockApi(page, { agents: [fakeAgent('Juriste', { mine: true })] })
  await page.goto('/')
  await openSidebar(page)
  await page.getByRole('button', { name: 'Compétences', exact: true }).first().click()
  await expect(page.getByText('Aucune compétence pour l’instant.'.replace('’', "'"))).toBeVisible()

  await page.getByRole('button', { name: 'Nouvelle compétence' }).click()
  const form = page.getByRole('form', { name: 'Nouvelle compétence' })
  await form.getByRole('textbox', { name: 'Nom' }).fill('Note de synthèse')
  await form.getByRole('textbox', { name: /Quand s'en servir/ }).fill('Rédiger une note de synthèse juridique')
  await form.getByRole('textbox', { name: /Instructions détaillées/ }).fill('1. Faits. 2. Problème. 3. Règles. 4. Analyse.')
  await form.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('button', { name: /Note de synthèse/ }).first()).toBeVisible()
  expect(api.skills[0]).toMatchObject({ name: 'Note de synthèse', confidential: false })

  // Fichier de référence (texte) : ajouté sous la compétence ouverte.
  const files = page.getByRole('region', { name: 'Fichiers de Note de synthèse' })
  await files.locator('input[type="file"]').setInputFiles({ name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from('# Plan\nI. Faits') })
  await expect(files.getByText('plan.md')).toBeVisible()
  await page.screenshot({ path: info.outputPath('competences.png') })

  // Confier la compétence à l'agent, depuis son studio.
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  const picker = page.getByRole('group', { name: 'Compétences' })
  await picker.getByRole('switch', { name: 'Note de synthèse' }).check()
  await expect(picker.getByRole('switch', { name: 'Note de synthèse' })).toBeChecked()
  await page.screenshot({ path: info.outputPath('studio-competences.png') })
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
  await expect.poll(() => api.agentSaves.at(-1)?.skills).toEqual([api.skills[0]!.id])
})
