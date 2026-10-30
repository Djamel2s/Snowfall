import { expect, test } from '@playwright/test'
import { fakeAgent, mockApi } from './mock-api'

// Parcours : améliorer un agent. Un 👎 partagé (avec accord) devient un cas
// proposé ; l'auteur le valide, ajoute un cas, lance l'amélioration mesurée et
// applique la proposition. Rien n'est appliqué sans son clic.

const agents = [fakeAgent('Juriste', { mine: true, tools: ['search_knowledge'], color: 'lavender' })]

async function openStudio(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('button', { name: 'Modifier Juriste' }).click()
}

test('👎 sur la réponse d’un agent : partage seulement si coché', async ({ page }, info) => {
  const api = await mockApi(page, { agents, answer: 'Vingt-cinq jours.' })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).waitFor()
  const menu = page.getByRole('button', { name: 'Ouvrir le menu' })
  if (await menu.isVisible().catch(() => false)) await menu.click()
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click()
  await page.getByRole('region', { name: 'Mes agents' }).getByRole('button', { name: /^Juriste/ }).click()
  await page.getByPlaceholder(/Posez votre question/).fill('Combien de jours de congés ?')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Vingt-cinq jours.')).toBeVisible()

  await page.getByRole('button', { name: 'Mauvaise réponse' }).click()
  const share = page.getByRole('checkbox', { name: 'Aider l’auteur de l’agent' })
  await expect(share).not.toBeChecked()
  await page.getByRole('textbox', { name: /Qu’est-ce qui n’allait pas/ }).fill('Il manque la source.')
  await share.check()
  await page.screenshot({ path: info.outputPath('partage.png') })
  await page.getByRole('button', { name: 'Envoyer le commentaire' }).click()
  await expect.poll(() => api.feedbackCalls.length).toBe(2)
  expect(api.feedbackCalls.map(({ rating, share: shared }) => [rating, shared ?? false])).toEqual([['down', false], ['down', true]])
  expect(api.unknown).toEqual([])
})

test('studio : valider un cas, améliorer, appliquer la proposition mesurée', async ({ page }, info) => {
  const api = await mockApi(page, { agents })
  await openStudio(page)
  const quality = page.getByRole('region', { name: 'Qualité' })
  await expect(quality.getByText('Combien de jours de congés ?')).toBeVisible()
  await expect(quality.getByText('Proposé par un utilisateur')).toBeVisible()
  // Un seul cas validé : pas encore d'amélioration possible.
  await quality.getByRole('textbox', { name: 'Ce qu’une bonne réponse doit faire' }).first().fill('Cite la source du nombre de jours.')
  await quality.getByRole('button', { name: 'Valider le cas' }).click()
  await expect(quality.getByRole('button', { name: 'Améliorer' })).toBeDisabled()

  await quality.getByRole('textbox', { name: 'Question' }).fill('Le télétravail est-il possible ?')
  await quality.getByRole('textbox', { name: /Ajouter le cas/ }).fill('Renvoie à l’accord télétravail.')
  await quality.getByRole('button', { name: 'Ajouter le cas' }).click()
  await quality.getByRole('button', { name: 'Améliorer' }).click()

  const result = quality.getByRole('status')
  await expect(result).toContainText('0/2 → 2/2')
  await expect(result).toContainText('Juge : mistral:mistral-large-latest')
  await expect(result).toContainText('Cite toujours la source.')
  await page.screenshot({ path: info.outputPath('amelioration.png'), fullPage: true })
  // Rien d'appliqué avant le clic.
  expect(api.appliedProposals).toEqual([])
  await quality.getByRole('button', { name: 'Appliquer' }).click()
  await expect.poll(() => api.appliedProposals).toEqual(['11111111-1111-4111-8111-111111111111'])
  await expect(page.getByRole('textbox', { name: /Instructions/ }).first()).toHaveValue('Tu es Juriste. Cite toujours la source.')
  await quality.getByText('Versions').click()
  await expect(quality.getByText(/v2 · amélioration/)).toBeVisible()
  expect(api.unknown).toEqual([])
})

test('studio : instructions modifiées sans enregistrer — on ne mesure pas', async ({ page }) => {
  await mockApi(page, { agents })
  await openStudio(page)
  await page.getByRole('textbox', { name: /Instructions/ }).first().fill('Autre chose')
  const quality = page.getByRole('region', { name: 'Qualité' })
  await expect(quality.getByText('Enregistrez d’abord vos modifications.')).toBeVisible()
})
