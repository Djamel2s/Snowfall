import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : menu sur téléphone (glisse à l'ouverture et à la fermeture, le logo
// le referme) ; conversation temporaire : contour du champ en pointillés.

/**
 * Position horizontale du menu à chaque image, pendant 1,5 s, relevée DANS la
 * page (aucun aller-retour : fiable même quand la machine est chargée). Le relevé
 * démarre avant l'action qui déclenche l'animation.
 */
async function track(page: Page, action: () => Promise<void>) {
  const sampling = page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const sidebar = document.querySelector('aside.sidebar')!
        const xs: number[] = []
        const start = performance.now()
        const step = () => {
          xs.push(Math.round(sidebar.getBoundingClientRect().x))
          if (performance.now() - start < 1_500) requestAnimationFrame(step)
          else resolve(xs)
        }
        requestAnimationFrame(step)
      }),
  )
  await action()
  return sampling
}

test('téléphone : le menu glisse à l’ouverture et à la fermeture ; le logo le referme', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'Menu du téléphone')
  await mockApi(page)
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  // Animations visibles (le mock active « réduire les animations »).
  await page.evaluate(() => document.documentElement.classList.remove('reduce-motion'))

  const opening = await track(page, () => page.getByRole('button', { name: 'Ouvrir le menu' }).click())
  // Des positions intermédiaires : le menu glisse, il n'apparaît pas d'un coup.
  expect(opening.some((x) => x < 0 && x > -300)).toBe(true)
  await expect.poll(() => page.locator('aside.sidebar').evaluate((element) => Math.round(element.getBoundingClientRect().x))).toBe(0)
  await expect(page.locator('.mobile-scrim')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: info.outputPath('menu-ouvert.png') })

  // Le logo en haut à gauche referme le menu, en glissant aussi.
  const closing = await track(page, () => page.getByRole('button', { name: 'Snowfall', exact: true }).click())
  expect(closing.some((x) => x < 0 && x > -300)).toBe(true)
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
