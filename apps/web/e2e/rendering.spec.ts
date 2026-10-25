import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Rendu des réponses (code coloré, formules) SOUS LA CSP DE PRODUCTION : Vite
// n'envoie pas de CSP en développement, donc on l'applique ici, lue dans la
// configuration nginx. Toute violation (HTML brut, style en ligne, Trusted Types)
// fait échouer le test.

const nginx = readFileSync(fileURLToPath(new URL('../../../infra/nginx/security-headers.conf', import.meta.url)), 'utf8')
const csp = /Content-Security-Policy "([^"]+)"/.exec(nginx)![1]!
  // Vite (développement) : script de rechargement à chaud et module client en ligne ; hors sujet ici.
  .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
  .replace(/ ?report-uri [^;]+;?/, '')
  .replace(/ ?report-to [^;]+;?/, '')
  .replace('upgrade-insecure-requests;', '')

const answer = [
  'Voici la fonction :',
  '',
  '```python',
  'def aire(r):',
  '    return 3.14 * r ** 2  # cercle',
  '```',
  '',
  'La formule \\(A = \\pi r^2\\) donne, en bloc :',
  '',
  '$$',
  '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
  '$$',
  '',
  'Le tout coûte 5 $ et 10 $.',
].join('\n')

test('code coloré et formules, sans aucune violation de la CSP de production', async ({ page }, info) => {
  await mockApi(page, { answer })
  // Document servi avec la CSP de production.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback()
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } })
  })
  const violations: string[] = []
  await page.exposeFunction('__cspViolation', (text: string) => violations.push(text))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })

  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Montre-moi')
  await page.keyboard.press('Enter')
  const reply = page.locator('.message-assistant .markdown').last()

  // Code : de vrais jetons Prism (mot-clé, commentaire).
  await expect(reply.locator('.pt-keyword', { hasText: 'def' })).toBeVisible()
  await expect(reply.locator('.pt-comment')).toContainText('# cercle')
  // Formules : MathML natif, en ligne et en bloc.
  await expect(reply.locator('math')).toHaveCount(2)
  await expect(reply.locator('.md-math-block math')).toBeVisible()
  // Les montants restent du texte.
  await expect(reply).toContainText('Le tout coûte 5 $ et 10 $.')
  await page.screenshot({ path: info.outputPath('rendu.png') })

  // Seule exception : les <style> que Vite injecte EN DÉVELOPPEMENT (en production,
  // les feuilles de style sont des fichiers). Styles en ligne d'attribut, Trusted
  // Types (HTML brut) et scripts restent interdits.
  expect(violations.filter((violation) => !violation.startsWith('style-src-elem'))).toEqual([])
})
