import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : ouvrir la carte des agents, sélectionner un agent, l'ajouter à
// l'équipe d'un autre en tirant un lien (Maj + glisser).

const agents = [
  { ...fakeAgent('Juriste', { mine: true, tools: ['search_knowledge', 'delegate', 'web_search'], color: 'lavender' }), delegates: ['agent-supportrh'] },
  fakeAgent('Support RH', { mine: true, tools: ['search_knowledge'], color: 'coral' }),
  fakeAgent('Analyste', { mine: true, tools: ['code_interpreter'], color: 'mint' }),
]

test('carte : nœuds et liens, fiche de l’agent, lien tiré = ajout à l’équipe', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Glisser-déposer à la souris : parcours bureau')
  await mockApi(page, { agents, orgTools: ['search_knowledge', 'delegate', 'web_search', 'code_interpreter'] })
  await page.goto('/')
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Carte des agents' }).click()
  const map = page.getByRole('region', { name: 'Carte des agents' })
  await expect(map.locator('.graph-node-agent')).toHaveCount(3)
  await expect(map.locator('.graph-link-team')).toHaveCount(1)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: info.outputPath('carte.png') })

  // Fiche : clic sur Juriste.
  const juriste = map.locator('.graph-node-agent', { hasText: 'Juriste' })
  await juriste.locator('.graph-node-core').click({ force: true })
  await expect(map.locator('.agent-graph-card')).toContainText('Support RH')

  // Maj + glisser de Juriste vers Analyste : ajouté à l'équipe.
  const from = await juriste.locator('.graph-node-core').boundingBox()
  const to = await map.locator('.graph-node-agent', { hasText: 'Analyste' }).locator('.graph-node-core').boundingBox()
  const saved = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/api/agents/agent-juriste'))
  await page.keyboard.down('Shift')
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  expect(((await saved).postDataJSON() as { delegates: string[] }).delegates).toEqual(['agent-supportrh', 'agent-analyste'])
})

test('carte sur mobile : ouverte depuis le menu, agent sélectionné au toucher', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Parcours mobile')
  await mockApi(page, { agents, orgTools: ['search_knowledge', 'delegate'] })
  await page.goto('/')
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Carte des agents' }).click()
  const map = page.getByRole('region', { name: 'Carte des agents' })
  await expect(map.locator('.graph-node-agent')).toHaveCount(3)
  // Toucher : le nœud bouge encore (simulation) ; on vise sa position du moment.
  const node = map.getByRole('button', { name: 'Support RH' })
  // Un humain retouche si le nœud a glissé sous son doigt : on fait pareil.
  await expect(async () => {
    await node.locator('.graph-node-core').tap({ force: true })
    await expect(map.locator('.agent-graph-card')).toContainText('Support RH', { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await expect(node).toHaveAttribute('aria-pressed', 'true')
})

test('carte au clavier : chaque agent est un bouton qui ouvre sa fiche', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Parcours clavier')
  await mockApi(page, { agents, orgTools: ['search_knowledge', 'delegate'] })
  await page.goto('/')
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Carte des agents' }).click()
  const map = page.getByRole('region', { name: 'Carte des agents' })
  await map.getByRole('button', { name: 'Support RH' }).focus()
  await page.keyboard.press('Enter')
  await expect(map.locator('.agent-graph-card')).toContainText('Support RH')
  await page.keyboard.press('Enter')
  await expect(map.locator('.agent-graph-card')).toHaveCount(0)
})
