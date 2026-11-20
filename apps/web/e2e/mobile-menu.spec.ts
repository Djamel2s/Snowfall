import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : menu sur téléphone (glisse à l'ouverture et à la fermeture, le logo
// le referme) ; conversation temporaire : contour du champ en pointillés.

/**
 * Le menu glisse-t-il ? Écoute, DANS la page, le début d'une transition CSS de
 * « transform » sur le menu, et relève aussi sa position à chaque image pendant
 * 1,5 s. L'événement est la preuve fiable : sur une machine chargée, le
 * navigateur peut sauter les images intermédiaires (le relevé seul échouait
 * parfois quand toute la suite tournait). L'écoute démarre avant l'action.
 */
async function track(page: Page, action: () => Promise<void>) {
  await page.evaluate(() => {
    const sidebar = document.querySelector('aside.sidebar')!
    const state = { transform: false, xs: [] as number[] }
    ;(window as unknown as { __slide: typeof state }).__slide = state
    sidebar.addEventListener('transitionstart', (event) => {
      if ((event as TransitionEvent).propertyName === 'transform') state.transform = true
    })
    const start = performance.now()
    const step = () => {
      state.xs.push(Math.round(sidebar.getBoundingClientRect().x))
      if (performance.now() - start < 1_500) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  await action()
  await page.waitForTimeout(1_600)
  return page.evaluate(() => (window as unknown as { __slide: { transform: boolean; xs: number[] } }).__slide)
}

/** Une transition de « transform » a démarré, ou une position intermédiaire a été vue. */
const slid = (track: { transform: boolean; xs: number[] }) => track.transform || track.xs.some((x) => x < 0 && x > -300)

test('téléphone : le menu glisse à l’ouverture et à la fermeture ; le logo le referme', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'Menu du téléphone')
  await mockApi(page)
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  // Animations visibles (le mock active « réduire les animations »).
  await page.evaluate(() => document.documentElement.classList.remove('reduce-motion'))

  const opening = await track(page, () => page.getByRole('button', { name: 'Ouvrir le menu' }).click())
  // Le menu glisse (transition), il n'apparaît pas d'un coup.
  expect(slid(opening)).toBe(true)
  await expect.poll(() => page.locator('aside.sidebar').evaluate((element) => Math.round(element.getBoundingClientRect().x))).toBe(0)
  await expect(page.locator('.mobile-scrim')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: info.outputPath('menu-ouvert.png') })

  // Le logo en haut à gauche referme le menu, en glissant aussi.
  const closing = await track(page, () => page.getByRole('button', { name: 'Snowfall', exact: true }).click())
  expect(slid(closing)).toBe(true)
  await expect.poll(() => page.locator('aside.sidebar').evaluate((element) => Math.round(element.getBoundingClientRect().x))).toBeLessThan(-250)
  await expect(page.locator('aside.sidebar')).not.toHaveClass(/sidebar-open/)
  await expect(page.locator('.mobile-scrim')).toHaveCSS('opacity', '0')
  // Voile fermé : inerte (ni clic, ni tabulation).
  await expect(page.getByRole('button', { name: 'Fermer le menu' })).toHaveCount(0)
})

test('conversation temporaire : seul le contour du champ change, en pointillés', async ({ page }, info) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const composer = page.locator('.composer')
  await expect(composer).toHaveCSS('border-top-style', 'solid')
  await page.getByRole('button', { name: 'Conversation temporaire' }).click()
  await expect(composer).toHaveCSS('border-top-style', 'dashed')
  await page.screenshot({ path: info.outputPath('temporaire.png') })
  await page.getByRole('button', { name: 'Conversation temporaire' }).click()
  await expect(composer).toHaveCSS('border-top-style', 'solid')
})
