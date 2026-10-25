import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Fiche d'un connecteur dans la barre latérale étroite : tout reste visible,
// rien ne déborde ; la suppression (deux clics) part sans corps JSON vide.

async function addZapier(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Connecteurs', exact: true }).first().click()
  await page.getByRole('tab', { name: 'Catalogue' }).click()
  await page.getByRole('textbox', { name: 'Chercher un connecteur' }).fill('zapier')
  await page.getByRole('region', { name: 'Catalogue' }).getByRole('button', { name: /Zapier/ }).click()
  const entry = page.getByRole('region', { name: 'Zapier', exact: true })
  await entry.getByRole('textbox', { name: "Clé d'API ou jeton" }).fill('cle')
  await entry.getByRole('button', { name: 'Ajouter', exact: true }).click()
  return page.getByRole('region', { name: 'Zapier', exact: true })
}

test('fiche : outils personnalisés sans débordement, boutons visibles', async ({ page }) => {
  await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  const card = await addZapier(page)
  // Clé partagée : pas d'étape de connexion, les outils se lisent aussitôt.
  await expect(card.getByRole('list', { name: 'Étapes' }).locator('li')).toHaveCount(3)
  await card.getByRole('radio', { name: /Personnalisé/ }).click()
  await card.getByRole('button', { name: 'Détails de Rechercher' }).click()
  // Ni la fiche ni la liste des outils ne défilent de côté (rien de coupé à gauche).
  for (const box of [card, card.locator('.tool-list'), ...(await card.locator('.tool-list > li').all())]) {
    expect(await box.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  }
  for (const name of ['Droit de Créer une page', 'Détails de Créer une page']) {
    const control = card.getByRole(name.startsWith('Droit') ? 'combobox' : 'button', { name })
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeInViewport()
  }
  const remove = card.getByRole('button', { name: 'Supprimer Zapier' })
  await remove.scrollIntoViewIfNeeded()
  await expect(remove).toBeInViewport()
  await card.screenshot({ path: test.info().outputPath('fiche.png') })
})

test('supprimer depuis la fiche : deux clics, la requête passe (pas de corps JSON vide)', async ({ page }) => {
  const api = await mockApi(page, { role: 'admin', platformTools: ['mcp'] })
  const card = await addZapier(page)
  await expect.poll(() => api.mcpServers.length).toBe(1)
  await expect(card.getByRole('radio', { name: /Lecture seule/ })).toBeVisible()
  await card.getByRole('button', { name: 'Supprimer Zapier' }).click()
  await card.getByRole('button', { name: 'Confirmer la suppression de Zapier' }).click()
  await expect.poll(() => api.mcpServers.length).toBe(0)
  await expect(page.getByRole('tab', { name: 'Ajoutés (0)' })).toBeVisible()
  expect(api.emptyJsonBodies).toEqual([])
})
