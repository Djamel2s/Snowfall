import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : l'agent cherche sur le web et lit une page ; on voit ce qu'il fait,
// puis on relit son activité, on vérifie une citation (extrait, provenance), et
// aucune requête ne part vers un site tiers (icônes servies par Snowfall).

test('activité gardée, citations vérifiables, sources lues non citées, aucun appel tiers', async ({ page, isMobile }) => {
  const outside: string[] = []
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname
    if (!['localhost', '127.0.0.1'].includes(host)) outside.push(request.url())
  })
  await mockApi(page, { research: true })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Qui a gagné le dernier Ballon d’or ?')
  await page.keyboard.press('Enter')

  // Réponse enregistrée : une ligne repliée qui résume ce qui a été fait.
  const head = page.locator('.activity-head')
  // Une ligne discrète : la durée ; le détail au survol, le fil au clic.
  await expect(head).toContainText('Travaillé pendant 5,8 s')
  await expect(head.locator('.activity-label')).toHaveAttribute('title', '1 recherche · 1 page lue')
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await head.click()
  const steps = page.locator('.activity-step')
  await expect(steps).toHaveCount(2)
  await expect(steps.first()).toContainText('Recherche « Ballon d’or 2026 vainqueur »')
  await expect(steps.first()).toContainText('1,4 s')
  await expect(steps.nth(1)).toContainText('Lecture de lemonde.fr')
  // Ce que la recherche a trouvé : les sources citées portent leur numéro, l'autre non.
  await expect(steps.first().locator('.activity-source.cited')).toHaveCount(2)
  await expect(steps.first().locator('.activity-source:not(.cited)')).toContainText('fr.wikipedia.org')

  // Citation dans le texte : pastille du site, carte avec l'extrait et la provenance.
  const chip = page.locator('.cite-chip').first()
  await expect(chip).toContainText('lemonde.fr')
  if (isMobile) await chip.click()
  else await chip.hover()
  const card = page.locator('.cite-card')
  await expect(card).toContainText('73 buts en club')
  await expect(card).toContainText('Recherche « Ballon d’or 2026 vainqueur »')
  const open = card.getByRole('link', { name: /Ouvrir lemonde.fr/ })
  await expect(open).toHaveAttribute('rel', /noreferrer/)
  await expect(open).toHaveAttribute('href', 'https://www.lemonde.fr/sport/ballon-or-2026')
  const box = await card.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  // Clavier : Échap referme la carte.
  await chip.focus()
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)

  // Deux citations à la suite : une pastille « +1 ».
  await expect(page.locator('.cite-chip').nth(1)).toContainText('+1')

  // Sous la réponse : les sources citées, puis celle lue sans être citée.
  await page.locator('.sources-toggle').click()
  await expect(page.locator('.sources-list > .source-card')).toHaveCount(2)
  await page.getByRole('button', { name: 'Aussi consultées (1)' }).click()
  await expect(page.locator('.sources-also .source-card')).toContainText('Wikipédia')

  // Icônes : demandées à Snowfall ; lemonde.fr a la sienne, les autres leur initiale.
  await expect(page.locator('img.site-icon').first()).toHaveAttribute('src', '/api/favicons/lemonde.fr')
  await expect(page.locator('.site-icon-letter').first()).toBeVisible()
  expect(outside).toEqual([])

  // Rechargée : l'activité est toujours là (gardée avec la réponse).
  await page.reload()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: /Qui a gagné le dernier Ballon/ }).first().click()
  await expect(page.locator('.activity-head')).toContainText('Travaillé pendant 5,8 s')
})

test('document cité : lu au passage surligné dans le panneau ; citation signalée en 👎 commenté', async ({ page, isMobile }) => {
  const mock = await mockApi(page, { documentAnswer: true })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Plafond hôtel à Paris ?')
  await page.keyboard.press('Enter')
  const chip = page.locator('.cite-chip').first()
  await expect(chip).toContainText('Politique de dépl')
  await chip.click()
  const card = page.locator('.cite-card')
  await expect(card).toContainText('Hôtels · p. 4')
  await expect(card).toContainText('Recherche dans les documents : « plafond hôtel Paris »')

  await card.getByRole('button', { name: 'Lire au passage cité' }).click()
  const panel = page.locator('.document-panel')
  await expect(panel).toContainText('Politique de déplacements.pdf')
  const cited = panel.locator('.document-passage.cited')
  await expect(cited).toContainText('Passage cité [1]')
  await expect(cited.locator('mark')).toContainText('120 € à Paris')
  await expect(cited).toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // Signaler : la raison rejoint le 👎 de la réponse.
  if (isMobile) await chip.click()
  else await chip.hover()
  await page.locator('.cite-card').getByRole('button', { name: 'Signaler cette citation' }).click()
  await page.locator('.cite-card').getByRole('button', { name: 'La source ne dit pas ça' }).click()
  await expect(page.locator('.cite-card')).toContainText('Signalée')
  expect(mock.feedbackCalls.at(-1)).toMatchObject({ rating: 'down', comment: 'Citation [1] (Politique de déplacements.pdf) : La source ne dit pas ça.' })
  await expect(page.getByRole('button', { name: 'Mauvaise réponse' }).first()).toHaveAttribute('aria-pressed', 'true')
})
