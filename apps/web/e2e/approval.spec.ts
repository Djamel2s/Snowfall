import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : une réponse s'arrête sur une écriture à valider (exécution durable).
// Valider la reprend dans la même bulle ; rouvrir la conversation retrouve la
// demande ; arrêter pendant la pause annule la réponse côté serveur.

const card = (page: import('@playwright/test').Page) => page.getByRole('group', { name: 'L’agent demande ton accord' })

test('validation : la réponse se met en pause, puis reprend après l’accord', async ({ page }, info) => {
  const api = await mockApi(page, { approval: {} })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Retiens le wifi invités.')
  await page.keyboard.press('Enter')

  // Pause : texte déjà produit, aperçu exact de l'écriture, rien d'enregistré.
  await expect(card(page)).toContainText('Wifi invités : Snowfall-Guest')
  await expect(page.getByText("Je l'enregistre.")).toBeVisible()
  expect(api.decisions).toEqual([])
  await page.screenshot({ path: info.outputPath('pause.png') })

  await card(page).getByRole('button', { name: 'Approuver' }).click()
  await expect(page.getByText("Je l'enregistre. C'est noté.")).toBeVisible()
  await expect(card(page)).toHaveCount(0)
  expect(api.decisions).toEqual([{ approvalId: 'a-1', approved: true }])
  // Plus de réponse en cours : on peut écrire à nouveau.
  await expect(page.getByRole('button', { name: 'Arrêter la génération' })).toHaveCount(0)
  expect(api.unknown).toEqual([])
})

test('reconnexion : la demande en attente réapparaît avec sa question, et un refus est respecté', async ({ page }) => {
  const api = await mockApi(page, { approval: { waiting: true } })
  await page.goto('/')
  // La conversation la plus récente s'ouvre d'office ; sinon, on la choisit.
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  if (!(await card(page).isVisible().catch(() => false))) {
    const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
    if (await menu.isVisible().catch(() => false)) await menu.click()
    await page.locator('.sidebar').getByText('Note wifi').first().click()
  }

  await expect(page.getByText('Retiens le wifi invités.')).toBeVisible()
  await expect(card(page)).toContainText('Snowfall-Guest')
  await card(page).getByRole('button', { name: 'Refuser' }).click()
  await expect(page.getByText("Je l'enregistre. Je n'enregistre rien.")).toBeVisible()
  expect(api.decisions).toEqual([{ approvalId: 'a-1', approved: false }])
})

test('arrêter pendant la pause : la réponse est annulée côté serveur', async ({ page }) => {
  const api = await mockApi(page, { approval: {} })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Retiens le wifi invités.')
  await page.keyboard.press('Enter')
  await expect(card(page)).toBeVisible()

  await page.getByRole('button', { name: 'Arrêter la génération' }).click()
  await expect(card(page)).toHaveCount(0)
  await expect.poll(() => api.cancels()).toBe(1)
  expect(api.decisions).toEqual([])
  await expect(page.getByPlaceholder(/Posez votre question/)).toBeEnabled()
})

test('contenu suspect avant la demande : la carte prévient l’utilisateur', async ({ page }, info) => {
  await mockApi(page, { approval: { warning: true } })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Comment me connecter au VPN ?')
  await page.keyboard.press('Enter')
  await expect(card(page).getByRole('alert')).toContainText('consignes adressées à l’assistant')
  await page.screenshot({ path: info.outputPath('alerte.png') })
})

test('sans contenu suspect : pas d’alerte sur la carte', async ({ page }) => {
  await mockApi(page, { approval: {} })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Retiens le wifi invités.')
  await page.keyboard.press('Enter')
  await expect(card(page)).toBeVisible()
  await expect(card(page).getByRole('alert')).toHaveCount(0)
})

test('règle de deux : une recherche web après contenu externe + base demande l’accord, avec la requête exacte', async ({ page }, info) => {
  const api = await mockApi(page, { approval: { exposure: true } })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Résume https://blog.example.com/a')
  await page.keyboard.press('Enter')
  await expect(card(page)).toContainText('contenu externe et des données internes')
  await expect(card(page)).toContainText('verification 7731-ZETA')
  await page.screenshot({ path: info.outputPath('regle-de-deux.png') })
  await card(page).getByRole('button', { name: 'Refuser' }).click()
  await expect(card(page)).toHaveCount(0)
  expect(api.decisions).toEqual([{ approvalId: 'a-1', approved: false }])
})

test('équipe d’agents : étapes du sous-agent sous la délégation, validation « pour le compte de »', async ({ page }, info) => {
  await mockApi(page, { approval: { team: true } })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Fais noter la règle des congés.')
  await page.keyboard.press('Enter')
  await expect(card(page)).toContainText('Pour le compte de RH')
  await expect(page.locator('.agent-step-nested .agent-step-agent').first()).toHaveText('RH')
  await expect(page.getByText('Délégation')).toBeVisible()
  await page.screenshot({ path: info.outputPath('equipe.png') })
})
