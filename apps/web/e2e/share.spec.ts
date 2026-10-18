import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : partager une conversation (lien interne), l'ouvrir en lecture seule,
// révoquer ; exporter en Markdown et JSON.

test('partager : lien copié, ouvert en lecture seule, puis révoqué', async ({ page, context }, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await mockApi(page, { answer: 'Le télétravail est possible **trois jours** par semaine.' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Télétravail ?')
  await page.keyboard.press('Enter')
  await expect(page.getByText('trois jours')).toBeVisible()

  await page.getByRole('button', { name: 'Actions de la conversation' }).click()
  await page.getByRole('radio', { name: '30 j' }).click()
  const created = page.waitForRequest((request) => request.method() === 'POST' && /\/shares$/.test(request.url()))
  await page.getByRole('button', { name: 'Créer et copier le lien' }).click()
  expect((await created).postDataJSON()).toEqual({ days: 30 })
  await expect(page.getByText(/Valable jusqu’au/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('menu.png') })

  // Ouverture du lien : vue en lecture seule, sans zone de saisie. Le jeton part dans le corps.
  const opened = page.waitForRequest((request) => request.url().endsWith('/api/shares/open'))
  await page.goto(`/#partage=${'T'.repeat(43)}`)
  expect((await opened).postDataJSON()).toEqual({ token: 'T'.repeat(43) })
  await expect(page.getByRole('region', { name: 'Conversation partagée' })).toContainText('trois jours')
  await expect(page.getByText(/Lecture seule/)).toBeVisible()
  await expect(page.getByPlaceholder(/Posez votre question/)).toBeHidden()
  await page.screenshot({ path: info.outputPath('lecture.png') })
  await page.getByRole('region', { name: 'Conversation partagée' }).getByRole('button', { name: 'Fermer' }).click()
  await expect(page.getByPlaceholder(/Posez votre question/)).toBeVisible()
})

test('exporter : Markdown et JSON de la branche affichée', async ({ page }) => {
  await mockApi(page, { answer: 'Trente jours par an.' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Congés ?')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Trente jours par an.')).toBeVisible()
  await page.getByRole('button', { name: 'Actions de la conversation' }).click()

  const markdown = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Markdown' }).click()
  const md = await markdown
  expect(md.suggestedFilename()).toBe('conges.md')
  const text = await (await md.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'))
  expect(text).toContain('## Utilisateur\n\nCongés ?')
  expect(text).toContain('Trente jours par an.')

  const json = page.waitForEvent('download')
  await page.getByRole('button', { name: 'JSON' }).click()
  const file = await json
  const data = JSON.parse(await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8')))
  expect(data).toMatchObject({ format: 'snowfall.conversation', version: 1, messages: [{ role: 'user', content: 'Congés ?' }, { role: 'assistant', content: 'Trente jours par an.' }] })
})
