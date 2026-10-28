import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : un administrateur ouvre Administration › Pilotage. Des totaux de
// l'organisation (adoption, agents, consommation), jamais un nom de personne.

async function openAdmin(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: /menu|ouvrir la barre/i })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Administration' }).first().click()
}

test('pilotage : adoption, agents utiles, consommation ; la période se change', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await openAdmin(page)

  const active = page.getByRole('region', { name: 'Personnes actives' })
  await expect(active).toContainText('27')
  await expect(active).toContainText('sur 42 membres')
  await expect(active).toContainText('18 cette semaine')
  await expect(page.getByRole('img', { name: 'Activité par jour' }).locator('span')).toHaveCount(30)

  const agents = page.getByRole('region', { name: 'Agents les plus utilisés' })
  await expect(agents).toContainText('Assistant RH')
  await expect(agents).toContainText('412 messages · 19 personnes')
  await expect(agents).toContainText('93 % utiles')
  // Agent privé d'un collègue : compté, sans son nom.
  await expect(agents).toContainText('Agent non partagé')

  const usage = page.getByRole('region', { name: 'Consommation' })
  await expect(usage).toContainText(/1\s200\s000 \/ 2\s000\s000/)
  await expect(page.getByRole('region', { name: 'Outils ce mois-ci' })).toContainText('Exécutions de code')
  await expect(page.getByText('Totaux de l’organisation, jamais par personne.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('pilotage.png'), fullPage: true })

  await page.getByRole('radio', { name: '7 j' }).click()
  await expect(page.getByRole('img', { name: 'Activité par jour' }).locator('span')).toHaveCount(7)
  await expect(active).toContainText('18')
  // Mode strict de React (développement) : un effet peut partir deux fois ; seul l'ordre compte.
  expect([...new Set(api.adminOverviewCalls)]).toEqual([30, 7])
  expect(api.unknown).toEqual([])
})
