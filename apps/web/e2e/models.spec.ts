import { expect, test, type Page } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : le panneau « Modèles ». Un membre pose SA clé quand l'organisation
// l'autorise (clé vérifiée, jamais réaffichée, retirable) ; sinon il sait pourquoi
// le fournisseur n'est pas disponible. Un administrateur pose la clé de
// l'organisation et autorise les clés personnelles. Le choix du modèle y mène.

const KEY = 'sk-test-secret-abcd1234'

async function openPanel(page: Page, name: string) {
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (!(await page.locator('.sidebar.sidebar-open').count()) && (await menu.isVisible().catch(() => false))) await menu.click()
  await page.getByRole('button', { name, exact: true }).first().click()
}

/** Conversation vide : le choix du modèle est proposé au-dessus de la saisie. */
async function newConversation(page: Page) {
  await openPanel(page, 'Conversations')
  await page.getByRole('button', { name: 'Nouvelle conversation' }).first().click()
  await page.getByRole('button', { name: 'Changer d’agent ou de modèle' }).first().waitFor()
}

const row = (page: Page, name: string) => page.locator('.models-panel .list-row', { hasText: name })
/** Grille par défaut : une tuile par fournisseur. */
const tile = (page: Page, name: string) => page.locator('.models-panel').getByRole('button', { name: `Ouvrir ${name}`, exact: true })

test('membre : sa clé refusée puis acceptée, jamais réaffichée, le modèle devient disponible, puis retirée', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'member', personalKeys: ['openai'] })
  await page.goto('/')
  await openPanel(page, 'Modèles')
  // Grille par défaut, recherche, puis liste détaillée : une seule info d'état par ligne.
  await expect(page.locator('.models-panel .grid-tile')).toHaveCount(4)
  await page.screenshot({ path: info.outputPath('modeles-grille.png') })
  await page.getByRole('textbox', { name: 'Chercher un fournisseur' }).fill('open')
  await expect(page.locator('.models-panel .grid-tile')).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Chercher un fournisseur' }).fill('')
  await page.getByRole('button', { name: 'Afficher en liste détaillée' }).click()
  await expect(row(page, 'Mistral')).toContainText('Inclus')
  await expect(row(page, 'OpenAI')).toHaveText(/OpenAI\s*À connecter/)
  await row(page, 'OpenAI').getByRole('button').first().click()

  const card = page.getByRole('region', { name: 'OpenAI', exact: true })
  const input = card.getByLabel('Ma clé · Clé d’API')
  await input.fill('sk-bad-key-0000')
  await card.getByRole('button', { name: 'Connecter' }).click()
  await expect(page.getByRole('alert')).toContainText('Clé refusée par le fournisseur.')

  await input.fill(KEY)
  await card.getByRole('button', { name: 'Connecter' }).click()
  await expect(card.locator('.connector-ready-line').filter({ hasText: '••••1234' })).toBeVisible()
  await expect(card).toContainText('passent par ta clé')
  // La clé ne reste nulle part dans la page.
  expect(await page.content()).not.toContain(KEY)
  await page.screenshot({ path: info.outputPath('modeles-cle-personnelle.png') })

  await card.getByRole('button', { name: 'Modèles' }).click()
  await expect(row(page, 'OpenAI')).toContainText('Ma clé ••••1234')
  await expect(row(page, 'OpenAI')).toContainText('Prêt')

  // Catalogue relu : le modèle ouvert par la clé est proposé.
  await newConversation(page)
  await page.getByRole('button', { name: 'Changer d’agent ou de modèle' }).first().click()
  await expect(page.getByRole('option', { name: 'openai-m1' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Retirer : deux clics.
  await openPanel(page, 'Modèles')
  await row(page, 'OpenAI').getByRole('button').first().click()
  await card.getByRole('button', { name: 'Retirer' }).click()
  await card.getByRole('button', { name: 'Confirmer' }).click()
  await expect(card.getByLabel('Ma clé · Clé d’API')).toBeVisible()
  expect(api.keyCalls).toEqual(['set:personal:openai', 'set:personal:openai', 'remove:personal:openai'])
})

test('membre sans clé personnelle autorisée : il sait pourquoi, aucun champ à remplir', async ({ page }) => {
  await mockApi(page, { role: 'member' })
  await page.goto('/')
  await openPanel(page, 'Modèles')
  await tile(page, 'Anthropic').click()
  const card = page.getByRole('region', { name: 'Anthropic', exact: true })
  await expect(card).toContainText('Pas encore disponible')
  await expect(card.locator('input')).toHaveCount(0)
})

test('administrateur : clé de l’organisation, puis clés personnelles autorisées pour ce fournisseur', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await page.goto('/')
  await openPanel(page, 'Modèles')
  await tile(page, 'Google').click()
  const card = page.getByRole('region', { name: 'Google', exact: true })

  await card.getByLabel('Clé de l’organisation · Clé d’API').fill('AIza-organisation-9876')
  await card.getByRole('button', { name: 'Connecter' }).click()
  await expect(card.locator('.connector-admin .connector-ready-line')).toContainText('••••9876')
  await expect(card).toContainText('passent par la clé de l’organisation')

  await card.getByRole('switch', { name: 'Clés personnelles · Google' }).check()
  await expect(card.getByRole('switch', { name: 'Clés personnelles · Google' })).toBeChecked()
  await expect.poll(() => api.savedSettings.at(-1)?.personalKeyProviders).toEqual(['google'])
  // Autorisées : le champ « Ma clé » apparaît.
  await expect(card.getByLabel('Ma clé · Clé d’API')).toBeVisible()
  await page.screenshot({ path: info.outputPath('modeles-administrateur.png') })
})

test('choix du modèle : « Connecter un fournisseur » ouvre le panneau Modèles', async ({ page }) => {
  await mockApi(page, { role: 'member' })
  await page.goto('/')
  await newConversation(page)
  await page.getByRole('button', { name: 'Changer d’agent ou de modèle' }).first().click()
  await page.getByRole('button', { name: 'Connecter un fournisseur' }).click()
  await expect(tile(page, 'OpenAI')).toBeVisible()
})

test('administrateur : nouveau fournisseur (adresse refusée puis acceptée), modèle proposé, puis retiré', async ({ page }, info) => {
  const api = await mockApi(page, { role: 'admin' })
  await page.goto('/')
  await openPanel(page, 'Modèles')
  await page.getByRole('button', { name: 'Nouveau fournisseur' }).click()

  const form = page.getByRole('form', { name: 'Fournisseur personnalisé' })
  await form.getByLabel('Nom').fill('Routeur')
  await form.getByLabel('Adresse de l’API (https://…/v1)').fill('https://localhost/v1')
  await form.getByLabel('Clé d’API (facultative)').fill('sk-routeur-secret-4321')
  await form.getByRole('button', { name: 'Ajouter' }).click()
  await expect(page.getByRole('alert')).toContainText('Adresse refusée')

  await form.getByLabel('Adresse de l’API (https://…/v1)').fill('https://openrouter.ai/api/v1')
  await form.getByRole('button', { name: 'Ajouter' }).click()
  // Sa fiche s'ouvre : prêt, adresse et indice de la clé (administrateur).
  const card = page.getByRole('region', { name: 'Routeur', exact: true })
  await expect(card.locator('.connector-ready-line').first()).toContainText('2 modèles')
  await expect(card).toContainText('https://openrouter.ai/api/v1')
  await expect(card).toContainText('••••4321')
  expect(await page.content()).not.toContain('sk-routeur-secret-4321')
  await page.screenshot({ path: info.outputPath('modeles-personnalise.png') })

  // Dans la liste, puis dans le choix du modèle.
  await card.getByRole('button', { name: 'Modèles' }).click()
  await expect(tile(page, 'Routeur')).toBeVisible()
  await page.screenshot({ path: info.outputPath('modeles-grille-personnalise.png') })
  await newConversation(page)
  await page.getByRole('button', { name: 'Changer d’agent ou de modèle' }).first().click()
  await expect(page.getByRole('option', { name: /Routeur · llama-70b/ })).toBeVisible()
  await page.keyboard.press('Escape')

  // Retirer : deux clics.
  await openPanel(page, 'Modèles')
  await tile(page, 'Routeur').click()
  await card.getByRole('button', { name: 'Retirer' }).click()
  await card.getByRole('button', { name: 'Confirmer' }).click()
  await expect(tile(page, 'Routeur')).toHaveCount(0)
  expect(api.providerCalls).toEqual(['add:Routeur', 'add:Routeur', 'remove:cp-1'])
})

test('membre : voit les fournisseurs personnalisés, sans adresse, sans « Nouveau fournisseur » ni retrait', async ({ page }) => {
  await mockApi(page, { role: 'member', customProviders: [{ id: 'cp-1', name: 'Routeur', baseUrl: 'https://openrouter.ai/api/v1', hint: '4321' }] })
  await page.goto('/')
  await openPanel(page, 'Modèles')
  await expect(page.getByRole('button', { name: 'Nouveau fournisseur' })).toHaveCount(0)
  await tile(page, 'Routeur').click()
  const card = page.getByRole('region', { name: 'Routeur', exact: true })
  await expect(card).toContainText('2 modèles')
  await expect(card).not.toContainText('openrouter.ai')
  await expect(card).not.toContainText('4321')
  await expect(card.getByRole('button', { name: 'Retirer' })).toHaveCount(0)
})
