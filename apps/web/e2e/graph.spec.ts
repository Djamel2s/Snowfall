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
  // Un seul trait : le lien d'équipe. Les outils gravitent autour de LEUR agent (recherche web de Juriste, code d'Analyste).
  await expect(map.locator('.graph-link')).toHaveCount(1)
  await expect(map.locator('.graph-link-team')).toHaveCount(1)
  await expect(map.locator('.graph-satellite')).toHaveCount(2)
  await expect(map.locator('.graph-orbit', { has: page.locator('title', { hasText: 'Recherche web' }) })).toHaveCount(1)
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

// Neuf agents sans lien (A à I : l'identifiant du faux serveur vient des lettres du nom) ; un sur deux a des outils.
const many = Array.from({ length: 9 }, (_, index) =>
  fakeAgent(`Agent ${String.fromCharCode(65 + index)}`, { mine: true, tools: index % 2 ? ['web_search', 'code_interpreter'] : ['search_knowledge'], color: 'sky' }),
)

/** Tous les agents dans le cadre de la carte. */
async function allInside(page: import('@playwright/test').Page) {
  const map = page.getByRole('region', { name: 'Carte des agents' })
  const canvas = (await map.locator('.agent-graph-canvas').boundingBox())!
  for (const node of await map.locator('.graph-node-agent .graph-node-core').all()) {
    const box = await node.boundingBox()
    if (!box || box.x < canvas.x - 1 || box.y < canvas.y - 1 || box.x + box.width > canvas.x + canvas.width + 1 || box.y + box.height > canvas.y + canvas.height + 1) return false
  }
  return true
}

test('carte animée : neuf agents restent dans la fenêtre, satellites seulement autour des agents qui ont des outils', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Parcours bureau')
  await mockApi(page, { agents: many, orgTools: ['search_knowledge', 'web_search', 'code_interpreter'] })
  // Animations normales (le faux serveur les réduit par défaut).
  await page.route('**/api/me/preferences', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { preferences: { locale: 'fr', sendOnEnter: true, reduceMotion: 'off', memory: false, theme: 'dark', instructions: '' } } })
      : route.fallback(),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Carte des agents' }).click()
  const map = page.getByRole('region', { name: 'Carte des agents' })
  await expect(map).not.toHaveClass(/still/)
  await expect(map.locator('.graph-node-agent')).toHaveCount(9)
  // B, D, F, H : recherche web et code ; les autres, rien en orbite.
  await expect(map.locator('.graph-orbit')).toHaveCount(4)
  await expect(map.locator('.graph-satellite')).toHaveCount(8)
  await expect(map.locator('.graph-link')).toHaveCount(0)
  for (const wait of [500, 3000]) {
    await page.waitForTimeout(wait)
    expect(await allInside(page)).toBe(true)
  }
  // Carte compacte : tout tient sans dézoomer au minimum (sans rappel vers le centre, les agents s'éparpillent).
  const scale = Number((await map.locator('.agent-graph-canvas > svg > g').getAttribute('transform'))?.match(/scale\(([\d.]+)\)/)?.[1])
  // Mesuré : 0,90 avec le rappel, 0,55 sans.
  expect(scale).toBeGreaterThan(0.75)
})

test('carte : tous les agents restent dans la fenêtre ; « Recentrer » ; changer de panneau la ferme', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Parcours bureau')
  // Beaucoup d'agents sans lien : avant, les isolés partaient hors de la fenêtre.
  await mockApi(page, { agents: many, orgTools: ['search_knowledge', 'web_search', 'code_interpreter'] })
  await page.goto('/')
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Carte des agents' }).click()
  const map = page.getByRole('region', { name: 'Carte des agents' })
  await expect(map.locator('.graph-node-agent')).toHaveCount(9)
  const canvas = (await map.locator('.agent-graph-canvas').boundingBox())!
  const inside = () => allInside(page)
  await expect.poll(inside, { timeout: 10_000 }).toBe(true)

  // Après un déplacement de la vue, « Recentrer » ramène tout le monde.
  await page.mouse.move(canvas.x + 20, canvas.y + 20)
  await page.mouse.down()
  await page.mouse.move(canvas.x + canvas.width - 20, canvas.y + canvas.height - 20, { steps: 8 })
  await page.mouse.up()
  await map.getByRole('button', { name: 'Recentrer la carte' }).click()
  await expect.poll(inside, { timeout: 10_000 }).toBe(true)

  // Un clic dans la barre latérale ferme la carte.
  await page.getByRole('button', { name: 'Conversations', exact: true }).first().click()
  await expect(map).toHaveCount(0)
})
