import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : exporter une conversation en texte, en image (PNG) et en PDF
// (impression du navigateur, mise en page dédiée) — tout dans le navigateur.

test('export texte, image et PDF depuis le menu de la conversation', async ({ page }, info) => {
  await mockApi(page, { answer: 'Voici **25 jours** de congés.\n\n```python\nprint(25)\n```' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Combien de congés ?')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant .markdown')).toBeVisible()

  const openMenu = () => page.getByRole('button', { name: 'Actions de la conversation' }).click()
  const exports = () => page.getByRole('region', { name: 'Exporter' })

  await openMenu()
  let download = page.waitForEvent('download')
  await exports().getByRole('button', { name: 'Texte' }).click()
  const text = await readFile((await (await download).path())!, 'utf8')
  expect(text).toContain('Combien de congés ?')
  expect(text).toContain('Voici 25 jours de congés.')
  expect(text).not.toContain('**')

  download = page.waitForEvent('download')
  await exports().getByRole('button', { name: 'Image' }).click()
  const image = await download
  expect(image.suggestedFilename()).toMatch(/\.png$/)
  const bytes = await readFile((await image.path())!)
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  // PDF : la boîte d'impression du navigateur (simulée ici).
  await page.evaluate(() => {
    ;(window as unknown as { printed: number }).printed = 0
    window.print = () => void ((window as unknown as { printed: number }).printed += 1)
  })
  await exports().getByRole('button', { name: 'PDF' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1)

  // Mise en page imprimée : la conversation seule, sans barre latérale ni saisie.
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.composer-area')).toBeHidden()
  await expect(page.locator('.chat-topbar')).toBeHidden()
  await expect(page.locator('.message-assistant')).toBeVisible()
  await page.screenshot({ path: info.outputPath('impression.png'), fullPage: true })
})
