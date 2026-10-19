import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

// Parcours réel : connexion Keycloak avec enrôlement TOTP obligatoire, premier
// message, réponse, puis vérifications en base (chiffré au repos, RLS sans
// contexte, audit), et déconnexion. Lancé par scripts/e2e-real.mjs.

const username = process.env.E2E_USERNAME!
const password = process.env.E2E_PASSWORD!
const marker = `Repère-${Date.now()}`

/** Code TOTP (RFC 6238 : HMAC-SHA1, 30 s, 6 chiffres) à partir du secret base32 affiché. */
function totp(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of secret.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const hash = createHmac('sha1', key).update(counter).digest()
  const offset = hash[hash.length - 1]! & 0x0f
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** Requête SQL dans la base jetable (superutilisateur : voit tout, pour vérifier). */
function sql(query: string, role: 'postgres' | 'app' = 'postgres') {
  // Rôle applicatif : son propre mot de passe (DATABASE_URL), vu depuis le conteneur.
  const app = new URL(process.env.DATABASE_URL!)
  const connection = role === 'app' ? [`postgresql://${app.username}:${app.password}@localhost:5432/snowfall`] : ['-U', 'postgres', '-d', 'snowfall']
  const args = ['compose', '-p', 'snowfall-e2e', 'exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-tA', ...connection, '-c', query]
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function login(page: Page) {
  await page.goto('/')
  // Écran d'accueil de l'application : bouton vers Keycloak (s'il existe).
  const start = page.getByRole('button', { name: /se connecter|connexion|sign in|log in/i })
  if (await start.first().isVisible({ timeout: 5_000 }).catch(() => false)) await start.first().click()
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.locator('#kc-login').click()
  // Enrôlement TOTP obligatoire à la première connexion.
  await page.locator('#mode-manual').click()
  const secret = (await page.locator('#kc-totp-secret-key').innerText()).trim()
  await page.locator('#totp').fill(totp(secret))
  await page.locator('#userLabel').fill('e2e')
  await page.locator('#saveTOTPBtn, input[type="submit"], button[type="submit"]').first().click()
}

test('connexion réelle, premier message, données chiffrées en base, déconnexion', async ({ page }) => {
  await login(page)
  const composer = page.getByPlaceholder(/Posez votre question/)
  await expect(composer).toBeVisible({ timeout: 30_000 })

  await composer.fill(`Question de bout en bout ${marker}`)
  await page.keyboard.press('Enter')
  await expect(page.getByText(`Question de bout en bout ${marker}`).first()).toBeVisible()
  // Modèle de développement local (aucun fournisseur) : une réponse arrive.
  await expect(page.locator('.message-author').last()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => Number(sql("SELECT count(*) FROM messages WHERE role = 'assistant'")), { timeout: 30_000 }).toBeGreaterThan(0)

  // Au repos : jamais le texte, toujours le format chiffré « <version>:v1.… ».
  expect(sql(`SELECT count(*) FROM messages WHERE content LIKE '%${marker}%'`)).toBe('0')
  expect(sql("SELECT count(*) FROM messages WHERE content !~ '^[0-9]+:v1\\.'")).toBe('0')
  expect(sql(`SELECT count(*) FROM conversations WHERE title LIKE '%${marker}%'`)).toBe('0')
  // RLS : le rôle applicatif, sans contexte d'organisation, ne voit rien.
  expect(sql('SELECT count(*) FROM messages', 'app')).toBe('0')
  expect(sql('SELECT count(*) FROM conversations', 'app')).toBe('0')
  // Audit : la connexion et le message sont tracés, sans le contenu.
  expect(Number(sql("SELECT count(*) FROM audit_events WHERE event_type LIKE 'auth.%'"))).toBeGreaterThan(0)
  expect(sql(`SELECT count(*) FROM audit_events WHERE details::text LIKE '%${marker}%'`)).toBe('0')

  await page.screenshot({ path: test.info().outputPath('reel.png') })

  // Donnée sensible : marquée en base, titre masqué, audit sans la valeur.
  await page.getByRole('button', { name: 'Nouvelle conversation' }).first().click()
  await composer.fill('Mon numéro de sécu est 1 85 05 78 006 084 91')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Données sensibles détectées : cette conversation reste sur un modèle local.')).toBeVisible({ timeout: 30_000 })
  expect(sql('SELECT count(*) FROM conversations WHERE sensitive')).toBe('1')
  // Le titre (chiffré en base) s'affiche masqué dans l'historique.
  await expect(page.getByText('Mon numéro de sécu est •••').first()).toBeVisible()
  expect(sql("SELECT details->>'categories' FROM audit_events WHERE event_type = 'security.sensitive_detected'")).toBe('nir')
  expect(sql("SELECT count(*) FROM audit_events WHERE details::text LIKE '%006 084%'")).toBe('0')

  // Déconnexion : la session est révoquée côté serveur, pas seulement oubliée par le navigateur.
  await page.getByRole('button', { name: 'Se déconnecter' }).click()
  await expect.poll(async () => (await page.request.get('/api/auth/me')).status(), { timeout: 15_000 }).toBe(401)
})
