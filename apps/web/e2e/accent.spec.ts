import { expect, test, type Page } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : la réponse prend la couleur de son auteur — l'agent (son avatar),
// ou le bleu du logo pour un modèle.

const answer = ['Voici [la page Notion](https://app.notion.com/p/test) :', '', '- point un', '- point deux', '', '> à retenir', '', 'Commande `npm test`.', '', '| A | B |', '| - | - |', '| 1 | 2 |'].join('\n')

async function ask(page: Page) {
  await page.getByPlaceholder(/Posez votre question/).fill('Montre-moi')
  await page.keyboard.press('Enter')
  // Lien non vérifié : rendu en pastille (bouton), avec ⚠.
  const badge = page.locator('.message-assistant .md-link-unverified button').last()
  await expect(badge).toBeVisible()
  return badge.evaluate((element) => getComputedStyle(element).color)
}

test('agent rose : liens et puces à sa couleur ; modèle : bleu du logo', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Vérification visuelle sur bureau')
  const agent = { ...fakeAgent('Agent IA', { mine: true }), avatar: { kind: 'alien', color: 'pink', eyes: 'classic', accessory: 'none' } }
  await mockApi(page, { answer, agents: [agent] })
  await page.goto('/')
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: /Agent IA/ }).first().click()
  const pink = await ask(page)
  await page.screenshot({ path: info.outputPath('agent-rose.png') })

  // Nouvelle conversation, sans agent : c'est le modèle par défaut qui répond.
  await page.getByRole('button', { name: 'Nouvelle conversation' }).first().click()
  const blue = await ask(page)
  await page.screenshot({ path: info.outputPath('modele-bleu.png') })

  // Rose dominant pour l'agent, bleu dominant pour le modèle.
  // rgb(…) en 0–255, ou color(srgb …) en 0–1 (résultat de color-mix).
  const rgb = (value: string) => {
    const parts = value.match(/[\d.]+/g)!.slice(0, 3).map(Number)
    return value.startsWith('color(') ? parts.map((part) => part * 255) : parts
  }
  const [pr, , pb] = rgb(pink)
  const [br, , bb] = rgb(blue)
  expect(pr).toBeGreaterThan(pb - 30)
  expect(bb).toBeGreaterThan(br + 60)
  expect(pink).not.toBe(blue)
})

test('thème clair : la couleur de l’agent est assombrie pour rester lisible', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Vérification visuelle sur bureau')
  const agent = { ...fakeAgent('Agent IA', { mine: true }), avatar: { kind: 'alien', color: 'pink', eyes: 'classic', accessory: 'none' } }
  await mockApi(page, { answer, agents: [agent], theme: 'light' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: /Agent IA/ }).first().click()
  const color = await ask(page)
  await page.screenshot({ path: info.outputPath('agent-rose-clair.png') })
  const parts = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((part) => (color.startsWith('color(') ? part * 255 : part))
  // Luminance assez basse pour un texte lisible sur fond clair.
  expect(0.299 * parts[0]! + 0.587 * parts[1]! + 0.114 * parts[2]!).toBeLessThan(140)
})

test('photo d’agent : même taille et même position que le logo', async ({ page }, info) => {
  // PNG 1×1 : seule compte la boîte où la photo s'affiche.
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const agent = { ...fakeAgent('Alfred', { mine: true }), avatar: { kind: 'image', data: photo } }
  await mockApi(page, { answer: 'Bonjour.', agents: [agent] })
  await page.goto('/')
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: /Alfred/ }).first().click()
  await page.getByPlaceholder(/Posez votre question/).fill('salut')
  await page.keyboard.press('Enter')
  const image = page.locator('.message-assistant .message-avatar-image img').last()
  await expect(image).toBeVisible()
  // Position mesurée par rapport au haut de son message (nom au-dessus du texte).
  const box = (selector: string) =>
    page.locator(selector).last().evaluate((element) => {
      const own = element.getBoundingClientRect()
      const message = element.closest('.message')!.getBoundingClientRect()
      return { size: own.width, top: own.top - message.top }
    })
  const logo = await box('.message-user .message-user-logo')
  const agentPhoto = await box('.message-assistant .message-avatar-image img')
  expect(Math.abs(agentPhoto.size - logo.size)).toBeLessThanOrEqual(1)
  expect(Math.abs(agentPhoto.top - logo.top)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath('photo.png') })
})
