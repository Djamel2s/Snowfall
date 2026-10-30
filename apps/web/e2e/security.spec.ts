import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : l'administrateur règle la conservation des conversations, lit le
// journal d'audit (filtres, pages, détail) et l'exporte. Un membre n'y accède pas.

async function openSecurity(page: Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (!(await page.locator('.sidebar.sidebar-open').count()) && (await menu.isVisible().catch(() => false))) await menu.click()
  await page.getByRole('button', { name: 'Administration', exact: true }).first().click()
  await page.getByRole('tab', { name: 'Sécurité' }).click()
}

test('sécurité : conservation, journal filtré et paginé, détail, export', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await openSecurity(page)

  const retention = page.getByRole('region', { name: 'Conservation des conversations' })
  await expect(retention).toContainText('gardées jusqu’à ce que leur auteur les supprime')
  await retention.getByRole('combobox').selectOption('90')
  await expect.poll(() => api.securityCalls).toEqual(['retention:90'])
  await expect(retention).toContainText('sans activité depuis 90 jours sont effacées')

  const audit = page.getByRole('region', { name: 'Journal d’audit' })
  const rows = audit.getByRole('list', { name: 'Journal d’audit' }).getByRole('listitem')
  await expect(rows).toHaveCount(50)
  await expect(rows.first()).toContainText('camille@polaris.example')
  await page.screenshot({ path: info.outputPath('journal.png'), fullPage: true })
  await audit.getByRole('button', { name: 'Plus ancien' }).click()
  await expect(rows).toHaveCount(60)

  // Refus et échecs seulement : l'alerte antivirus, avec son détail.
  await audit.getByRole('switch', { name: 'Refus et échecs seulement' }).check()
  await expect(rows).toHaveCount(1)
  await rows.first().getByRole('button').click()
  await expect(rows.first()).toContainText('Eicar-Test-Signature')
  await expect(rows.first()).toContainText('10.0.0.7')
  await audit.getByRole('switch', { name: 'Refus et échecs seulement' }).uncheck()

  await audit.getByRole('group', { name: 'Catégories' }).getByRole('button', { name: 'Connexions' }).click()
  await expect(rows.first()).toContainText('auth.login')
  const download = page.waitForEvent('download')
  await audit.getByRole('button', { name: 'Exporter (CSV)' }).click()
  expect((await download).suggestedFilename()).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.csv$/)
  await expect.poll(() => api.securityCalls.at(-1)).toBe('export:auth')
  await expect(page.getByRole('region', { name: 'Droits des personnes (RGPD)' })).toContainText('Mon compte')
  expect(api.unknown).toEqual([])
})
