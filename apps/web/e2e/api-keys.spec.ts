import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : un administrateur crée une clé d'API pour un agent (montrée une
// seule fois), la retrouve par son début, puis la révoque en deux clics.

test('clé d’API : créée pour un agent, montrée une fois, révoquée', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin', agents: [fakeAgent('Support RH', { mine: true }), fakeAgent('Direction', { mine: true })] })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Paramètres' }).first().click()
  await page.getByRole('tab', { name: 'Organisation' }).click()
  await page.getByRole('tab', { name: 'Outils et intégrations' }).click()

  const card = page.getByRole('region', { name: 'Clés d’API'.replace('’', "'") })
  const form = card.getByRole('form', { name: 'Nouvelle clé d’API'.replace('’', "'") })
  // Rien à créer sans nom ni agent.
  await expect(form.getByRole('button', { name: 'Créer la clé' })).toBeDisabled()
  await form.getByRole('textbox', { name: /Nom/ }).fill('Intranet RH')
  await form.getByRole('checkbox', { name: 'Support RH' }).check()
  await form.getByRole('combobox').selectOption('30')
  await form.getByRole('button', { name: 'Créer la clé' }).click()

  // La clé complète, une seule fois, avec l'avertissement.
  const fresh = card.getByRole('status')
  await expect(fresh).toContainText('elle ne sera plus jamais affichée')
  await expect(fresh.locator('code')).toHaveText(/^snowfall_sk_[A-Za-z0-9]{46}$/)
  expect(api.apiKeyCreates).toEqual([{ name: 'Intranet RH', agentIds: ['agent-supportrh'], expiresInDays: 30 }])
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('cle.png') })
  await fresh.getByRole('button', { name: "C'est copié" }).click()
  await expect(card.getByRole('status')).toHaveCount(0)

  // Ensuite : seulement son début, ses agents, son expiration.
  const row = card.locator('.api-key-list li', { hasText: 'Intranet RH' })
  await expect(row).toContainText('snowfall_sk_Ab3Ab3…')
  await expect(row).toContainText('Support RH')
  await expect(row).toContainText('jamais utilisée')
  await expect(card.locator('code', { hasText: /^snowfall_sk_[A-Za-z0-9]{46}$/ })).toHaveCount(0)

  // Révoquer : deux clics.
  await row.getByRole('button', { name: 'Révoquer Intranet RH' }).click()
  await row.getByRole('button', { name: 'Confirmer la révocation de Intranet RH' }).click()
  await expect(row).toContainText('Révoquée')
  expect(api.apiKeys[0]?.revokedAt).not.toBeNull()
})
