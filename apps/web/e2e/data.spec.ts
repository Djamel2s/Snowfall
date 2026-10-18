import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : Mes données. Importer un export ChatGPT, exporter tout.

test('importer des conversations puis exporter toutes mes données', async ({ page }) => {
  const api = await mockApi(page, { role: 'member' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Paramètres' }).first().click()
  const card = page.getByRole('region', { name: 'Mes données' })

  const sent = page.waitForRequest((request) => request.url().endsWith('/api/conversations/import'))
  await card.locator('input[type=file]').setInputFiles({ name: 'conversations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ title: 'Voyage', mapping: {}, current_node: 'x' }])) })
  expect(((await sent).postDataJSON() as { title: string }[])[0]!.title).toBe('Voyage')
  await expect(card.getByText('1 conversation(s) importée(s).')).toBeVisible()

  // Fichier illisible : message clair, rien n'est envoyé.
  await card.locator('input[type=file]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{pas du json') })
  await expect(page.getByText('Ce fichier n’est pas un JSON lisible.')).toBeVisible()

  const download = page.waitForEvent('download')
  await card.getByRole('button', { name: 'Exporter toutes mes données' }).click()
  expect((await download).suggestedFilename()).toBe('mes-donnees-snowfall.json')
  expect(api.unknown).toEqual([])
})
