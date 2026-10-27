import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Diagramme Mermaid rendu SOUS LA CSP DE PRODUCTION du cadre des artifacts
// (infra/nginx/artifact-headers.conf) : aucun réseau, aucune ressource externe.
// Protège chaque mise à jour de Mermaid (une version qui chargerait une police,
// un worker ou un script externe ferait échouer ce test).

const nginx = readFileSync(fileURLToPath(new URL('../../../infra/nginx/artifact-headers.conf', import.meta.url)), 'utf8')
const csp = /Content-Security-Policy "([^"]+)"/.exec(nginx)![1]!

const diagram = 'Voici le schéma :\n\n```mermaid\nflowchart LR\n  A["Demande"] --> B{"Validation (manager)"}\n  B -->|oui| C["Congé posé"]\n  B -->|non| D["Refus motivé"]\n```'

test('diagramme Mermaid rendu dans le cadre, sans aucune violation de sa CSP de production', async ({ page }, info) => {
  await mockApi(page, { answer: diagram })
  // Le cadre est servi avec la CSP de nginx (Vite n'en envoie pas en développement).
  await page.route('**/artifact/mermaid.html', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } })
  })
  const violations: string[] = []
  const requests: string[] = []
  await page.exposeFunction('__cspViolation', (text: string) => violations.push(text))
  // Le script d'initialisation s'applique aussi au cadre.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(`${location.pathname} ${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  page.on('request', (request) => {
    if (request.frame() !== page.mainFrame()) requests.push(request.url())
  })

  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Fais un schéma de la validation des congés')
  await page.keyboard.press('Enter')
  const frame = page.frameLocator('.artifact-panel iframe')
  const svg = frame.locator('svg#artifact-diagram')
  await expect(svg).toBeVisible({ timeout: 15_000 })
  // Les quatre étapes sont bien dessinées (pas un SVG d'erreur).
  for (const label of ['Demande', 'Validation (manager)', 'Congé posé', 'Refus motivé']) await expect(svg).toContainText(label)
  await page.screenshot({ path: info.outputPath('mermaid.png') })

  expect(violations.filter((violation) => violation.startsWith('/artifact/'))).toEqual([])
  // Le cadre ne charge rien d'autre que sa propre page.
  expect(requests.filter((url) => !url.endsWith('/artifact/mermaid.html'))).toEqual([])
})
