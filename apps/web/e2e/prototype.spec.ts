import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Maquette (bloc ```prototype) : le HTML du modèle s'affiche avec le kit Snowfall,
// SOUS LA CSP DE PRODUCTION du cadre, et vit (écrans, fenêtre, onglets, interrupteur,
// message) grâce au seul moteur du kit. Le code du modèle, lui, ne s'exécute jamais.

const nginx = readFileSync(fileURLToPath(new URL('../../../infra/nginx/artifact-headers.conf', import.meta.url)), 'utf8')
const csp = /Content-Security-Policy "([^"]+)"/.exec(nginx)![1]!

const prototype = `<div class="app" data-device="mobile" data-accent="#E11D48" data-title="Réservation">
  <section class="screen" data-screen="accueil" data-title="Accueil">
    <header class="topbar"><span class="title">Salles</span><button class="icon-btn" data-open="filtres"><i data-icon="filter"></i></button></header>
    <div class="content stack">
      <div class="hero"><h1>Réservez une salle</h1><p class="muted">3 salles libres maintenant</p></div>
      <div class="tabs"><button data-tab="jour" aria-selected="true">Aujourd'hui</button><button data-tab="semaine">Semaine</button></div>
      <div data-panel="jour" class="list">
        <div class="item" data-go="salle"><span class="avatar">A</span><div class="body"><div>Atlas</div><div class="muted small">8 places</div></div><i data-icon="chevron-right"></i></div>
      </div>
      <div data-panel="semaine" hidden><p>Planning de la semaine</p></div>
      <img src="x" onerror="document.documentElement.dataset.pwned='onerror'">
      <a href="javascript:document.documentElement.dataset.pwned='lien'">Lien piégé</a>
      <svg><a><set attributeName="href" to="javascript:document.documentElement.dataset.pwned='svg'"/><text y="20">svg</text></a></svg>
      <script>document.documentElement.dataset.pwned = 'script'</script>
      <p>fin</script><script>document.documentElement.dataset.pwned = 'json'</script></p>
      <div style="background:url(https://pistage.example/p.png)">Fond</div>
    </div>
    <nav class="tabbar"><button data-go="accueil"><i data-icon="home"></i>Accueil</button><button data-go="salle"><i data-icon="calendar"></i>Salle</button></nav>
  </section>
  <section class="screen" data-screen="salle" data-title="Salle Atlas">
    <header class="topbar"><button class="icon-btn" data-back><i data-icon="arrow-left"></i></button><span class="title">Atlas</span></header>
    <div class="content stack">
      <div class="row between"><span>Écran</span><button class="switch" aria-checked="false" aria-label="Écran"></button></div>
      <button class="btn primary block" data-toast="Salle réservée">Réserver</button>
    </div>
  </section>
  <div class="sheet" id="filtres"><div class="stack"><h2>Filtres</h2><button class="btn block" data-close>Appliquer</button></div></div>
</div>`

const answer = `Voici la maquette :\n\n\`\`\`prototype\n${prototype}\n\`\`\``

test('maquette : écrans, fenêtre, onglets, interrupteur, message ; code du modèle neutralisé ; aucune violation de CSP', async ({ page }, info) => {
  await mockApi(page, { answer })
  await page.route('**/artifact/prototype.html', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } })
  })
  const violations: string[] = []
  const requests: string[] = []
  await page.exposeFunction('__cspViolation', (text: string) => violations.push(text))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as unknown as { __cspViolation: (text: string) => void }).__cspViolation(`${location.pathname} ${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  page.on('request', (request) => {
    if (request.frame() !== page.mainFrame()) requests.push(request.url())
  })

  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Fais la maquette d’une appli de réservation de salles')
  await page.keyboard.press('Enter')
  await expect(page.locator('.md-artifact-open')).toContainText('Réservation')
  const frame = page.frameLocator('.artifact-panel iframe')
  await expect(frame.locator('html[data-sf-ready="true"]')).toHaveCount(1, { timeout: 15_000 })
  const home = frame.locator('[data-screen="accueil"]')
  await expect(home).toBeVisible()
  await expect(home.locator('svg.sf-icon').first()).toBeVisible()
  await page.screenshot({ path: info.outputPath('accueil.png') })

  // Onglets.
  await frame.getByRole('button', { name: 'Semaine' }).click()
  await expect(frame.getByText('Planning de la semaine')).toBeVisible()
  // Fenêtre.
  await home.locator('[data-open="filtres"]').click()
  await expect(frame.locator('#filtres')).toBeVisible()
  await frame.getByRole('button', { name: 'Appliquer' }).click()
  await expect(frame.locator('#filtres')).toBeHidden()
  // Lien piégé : cliqué, il ne fait rien.
  await frame.getByText('Lien piégé').click()
  // Navigation, interrupteur, message, retour.
  await frame.getByRole('button', { name: 'Salle', exact: true }).click()
  const room = frame.locator('[data-screen="salle"]')
  await expect(room).toBeVisible()
  await expect(home).toBeHidden()
  await room.getByRole('button', { name: 'Écran' }).click()
  await expect(room.getByRole('button', { name: 'Écran' })).toHaveAttribute('aria-checked', 'true')
  await room.getByRole('button', { name: 'Réserver' }).click()
  await expect(frame.getByRole('status')).toHaveText('Salle réservée')
  await page.screenshot({ path: info.outputPath('salle.png') })
  await room.locator('[data-back]').click()
  await expect(home).toBeVisible()
  // Barre de la maquette : écran choisi, appareil.
  await frame.getByRole('combobox', { name: 'Écran' }).selectOption('salle')
  await expect(room).toBeVisible()
  await frame.getByRole('button', { name: 'Ordinateur' }).click()
  await expect(frame.locator('.sf-device')).toHaveAttribute('data-device', 'desktop')

  // Le code du modèle n'a jamais tourné : ni script, ni onerror, ni lien, ni animation SVG.
  expect(await frame.locator('html').getAttribute('data-pwned')).toBeNull()
  expect(await frame.locator('script:not(#sf-source)').count()).toBe(1)
  expect(await frame.locator('[onerror], set').count()).toBe(0)
  expect(violations.filter((violation) => violation.startsWith('/artifact/'))).toEqual([])
  // Le cadre ne charge rien d'autre que sa propre page (l'image « x » piégée n'est jamais demandée).
  expect(requests.filter((url) => !url.endsWith('/artifact/prototype.html'))).toEqual([])
})

test('maquette téléchargée : page autonome (kit inclus), le HTML du modèle y est une donnée', async ({ page }) => {
  await mockApi(page, { answer })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Maquette')
  await page.keyboard.press('Enter')
  await expect(page.locator('.artifact-panel')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.locator('.artifact-panel').getByRole('button', { name: 'Télécharger' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('reservation.html')
  const html = readFileSync(await file.path(), 'utf8')
  expect(html).toContain('.sf-device')
  expect(html).toContain('id="sf-source"')
  // Aucune balise du modèle n'apparaît telle quelle : « < » est échappé dans le bloc JSON.
  expect(html).not.toContain("<script>document.documentElement.dataset.pwned")
  expect(html).not.toContain('<img src="x" onerror')
})

const dashboard = `<div class="app" data-device="desktop" data-accent="#0EA5E9" data-title="Pilotage des ventes">
  <div class="layout">
    <nav class="sidebar"><div class="brand"><span class="avatar">P</span>Polaris</div>
      <a data-go="tableau"><i data-icon="chart"></i>Tableau</a><a data-go="clients"><i data-icon="users"></i>Clients</a></nav>
    <section class="screen main" data-screen="tableau" data-title="Tableau de bord">
      <div class="stack">
        <div class="row between"><h1>Ventes</h1><button class="btn primary" data-open="nouveau"><i data-icon="plus"></i>Nouvelle vente</button></div>
        <div class="grid three">
          <div class="card stat"><span class="label">Chiffre d'affaires</span><span class="value">4,2 M€</span><span class="trend up">+18 %</span></div>
          <div class="card stat"><span class="label">Marge</span><span class="value">22 %</span><span class="trend up">+2 pts</span></div>
          <div class="card stat"><span class="label">Clients</span><span class="value">128</span><span class="trend down">-3</span></div>
        </div>
        <table class="table"><tr><th>Client</th><th>Montant</th><th>Statut</th></tr><tr><td>Atlas</td><td>12 000 €</td><td><span class="badge success">Payé</span></td></tr></table>
      </div>
    </section>
    <section class="screen main" data-screen="clients" data-title="Clients"><h1>Clients</h1><div class="empty"><i data-icon="users"></i>Aucun client filtré</div></section>
  </div>
  <div class="modal" id="nouveau"><div class="stack"><h2>Nouvelle vente</h2><label class="field">Client<input placeholder="Nom"></label><button class="btn primary block" data-close>Enregistrer</button></div></div>
</div>`

test('maquette « ordinateur » : barre latérale, indicateurs ; en mobile, une colonne (selon la largeur de l’appareil)', async ({ page }, info) => {
  await mockApi(page, { answer: `Maquette :\n\n\`\`\`prototype\n${dashboard}\n\`\`\`` })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Tableau de bord des ventes')
  await page.keyboard.press('Enter')
  const frame = page.frameLocator('.artifact-panel iframe')
  await expect(frame.locator('html[data-sf-ready="true"]')).toHaveCount(1, { timeout: 15_000 })
  await expect(frame.locator('.sf-device')).toHaveAttribute('data-device', 'desktop')
  await expect(frame.locator('.sidebar [data-go="tableau"]')).toHaveAttribute('aria-current', 'page')
  await page.screenshot({ path: info.outputPath('ordinateur.png') })
  await frame.locator('.sidebar [data-go="clients"]').click()
  await expect(frame.getByText('Aucun client filtré')).toBeVisible()
  await frame.locator('.sidebar [data-go="tableau"]').click()

  await frame.getByRole('button', { name: 'Mobile' }).click()
  const columns = await frame.locator('.grid.three').evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(columns).toBe(1)
  await page.screenshot({ path: info.outputPath('mobile.png') })
})
