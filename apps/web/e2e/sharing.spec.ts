import { expect, test, type Page } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : droits fins — partager un prompt ou un agent avec une personne, un
// groupe ou toute l'organisation, en lecture ou en modification ; groupes gérés
// par un administrateur.

async function openSidebar(page: Page) {
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
}

test('prompt : partagé à une collègue en modification', async ({ page }, info) => {
  const api = await mockApi(page)
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  await openSidebar(page)
  await page.getByRole('button', { name: 'Prompts', exact: true }).first().click()
  await page.getByRole('button', { name: 'Nouveau prompt' }).click()
  await page.getByLabel('Nom', { exact: true }).fill('Traduction')
  await page.getByLabel('Texte du prompt').fill('Traduis en {{langue}}')
  await page.getByRole('button', { name: 'Enregistrer' }).click()

  // Un prompt reçu (pas à moi) ne se partage pas.
  await expect(page.getByRole('button', { name: 'Partager Résumé' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Partager Traduction' }).click()
  const panel = page.getByRole('region', { name: 'Accès à Traduction' })
  await expect(panel.getByText('Privé : vous seul y avez accès.')).toBeVisible()
  await panel.getByRole('combobox', { name: 'Partager avec…' }).selectOption({ label: 'sami@polaris.example' })
  await panel.getByRole('radiogroup', { name: 'Droit de sami@polaris.example' }).getByRole('radio', { name: 'Modification' }).click()
  await panel.getByRole('button', { name: 'Enregistrer l’accès' }).click()
  await expect.poll(() => api.accessCalls.length).toBe(1)
  expect(api.accessCalls[0]).toMatchObject({ type: 'prompt', grants: [{ principal: { type: 'user', id: 'u-2' }, permission: 'edit' }] })
  await expect(panel.getByRole('button', { name: 'Enregistré' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('partage-prompt.png') })
})

test('agent : partagé à toute l’organisation depuis son studio', async ({ page }) => {
  const api = await mockApi(page, { agents: [fakeAgent('Juriste', { mine: true }), fakeAgent('Comptable')] })
  await page.goto('/')
  await openSidebar(page)
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
  const panel = page.getByRole('region', { name: 'Accès à Juriste' })
  await panel.getByRole('combobox', { name: 'Partager avec…' }).selectOption({ label: 'Toute l’organisation'.replace('’', "'") })
  await panel.getByRole('button', { name: 'Enregistrer l’accès' }).click()
  await expect.poll(() => api.accessCalls.length).toBe(1)
  expect(api.accessCalls[0]).toMatchObject({ type: 'agent', id: 'agent-juriste', grants: [{ principal: { type: 'organization' }, permission: 'view' }] })
})

test('groupes : un administrateur crée un groupe et y ajoute des membres', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await page.goto('/')
  await openSidebar(page)
  await page.getByRole('button', { name: 'Paramètres' }).first().click()
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Membres et accès' }).click()
  const card = page.getByRole('region', { name: 'Groupes' })
  await card.getByRole('textbox', { name: 'Nom du groupe' }).fill('Juridique')
  await card.getByRole('button', { name: 'Créer' }).click()
  const members = card.getByRole('group', { name: 'Membres de Juridique' })
  await members.getByRole('checkbox', { name: 'camille@polaris.example' }).check()
  await expect.poll(() => api.groups[0]?.memberIds).toEqual(['u-1'])
  await expect(card.getByText('1 membre(s)')).toBeVisible()
  await page.screenshot({ path: info.outputPath('groupes.png') })
})
