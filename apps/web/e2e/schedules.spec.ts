import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : planifier un agent depuis le catalogue (chaque semaine, ou à chaque
// document ajouté), la retrouver dans « Mes tâches », la lancer, la mettre en pause.

const agents = [fakeAgent('Veille', { mine: true, tools: ['search_knowledge', 'web_search'], color: 'gold' })]

async function openAgents(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
}

test('planifier une veille hebdomadaire, la lancer et la mettre en pause', async ({ page }, info) => {
  const api = await mockApi(page, { agents })
  await openAgents(page)
  await page.getByRole('button', { name: 'Planifier Veille' }).click()
  const form = page.getByRole('form', { name: 'Planifier Veille' })
  await form.getByRole('textbox', { name: 'Nom' }).fill('Veille du lundi')
  await form.getByRole('textbox', { name: 'Consigne' }).fill('Fais le point des nouveautés de la semaine.')
  await form.getByRole('radio', { name: 'Chaque semaine' }).click()
  await form.getByRole('combobox', { name: 'Jour' }).selectOption({ label: 'lundi' })
  await form.getByRole('combobox', { name: 'Heure' }).selectOption('8')
  await expect(form.getByText('Les écritures attendent ta validation dans la conversation.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('planifier.png'), fullPage: true })
  await form.getByRole('button', { name: 'Créer la tâche' }).click()

  const tasks = page.getByRole('region', { name: 'Mes tâches' })
  await expect(tasks.getByText('Veille du lundi')).toBeVisible()
  await expect(form).toHaveCount(0)
  const created = api.schedules[0] as Record<string, unknown>
  expect([created.kind, created.cadence, created.weekday, created.hour, typeof created.timezone]).toEqual(['schedule', 'weekly', 1, 8, 'string'])

  await tasks.getByRole('button', { name: 'Lancer maintenant : Veille du lundi' }).click()
  await expect.poll(() => api.scheduleRuns.length).toBe(1)
  // Case contrôlée : elle change au retour du serveur.
  const toggle = tasks.getByRole('switch', { name: /Activer ou mettre en pause/ })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect(tasks.getByText(/En pause/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('taches.png'), fullPage: true })
  expect(api.unknown).toEqual([])
})

test('déclencheur : proposé seulement pour un agent qui a une base', async ({ page }) => {
  const api = await mockApi(page, { agents: [...agents, fakeAgent('Rédacteur', { mine: true, tools: ['web_search'] })] })
  await openAgents(page)
  await page.getByRole('button', { name: 'Planifier Rédacteur' }).click()
  await expect(page.getByRole('radio', { name: 'Document ajouté' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Annuler' }).click()
  await page.getByRole('button', { name: 'Planifier Veille' }).click()
  const form = page.getByRole('form', { name: 'Planifier Veille' })
  await form.getByRole('radio', { name: 'Document ajouté' }).click()
  await expect(form.getByRole('combobox', { name: 'Heure' })).toHaveCount(0)
  await form.getByRole('textbox', { name: 'Consigne' }).fill('Résume le nouveau document.')
  await form.getByRole('button', { name: 'Créer la tâche' }).click()
  await expect(page.getByText('À chaque document ajouté')).toBeVisible()
  expect((api.schedules[0] as { kind: string }).kind).toBe('knowledge')
})
