import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

// Parcours : retrouver un fichier déjà envoyé et le joindre à la conversation en
// cours ; le supprimer demande un second clic.

const file = { id: 'file-1', name: 'contrat.pdf', kind: 'document' as const, mediaType: 'application/pdf', size: 24_000, messageId: 'm-1', createdAt: '2026-10-20T09:00:00.000Z', conversationId: 'c-old' }

test('joindre un fichier déjà envoyé, puis en supprimer un autre en deux clics', async ({ page }, info) => {
  const api = await mockApi(page, { files: [file, { ...file, id: 'file-2', name: 'ancien.pdf' }] })
  await page.goto('/')
  await page.getByPlaceholder(/Posez votre question/).fill('Bonjour')
  await page.keyboard.press('Enter')
  await expect(page.locator('.message-assistant .markdown')).toBeVisible()

  await page.getByRole('button', { name: 'Réglages de la conversation' }).click()
  const card = page.getByRole('region', { name: 'Mes fichiers' })
  await expect(card.getByText('contrat.pdf')).toBeVisible()
  await page.screenshot({ path: info.outputPath('mes-fichiers.png') })
  await card.getByRole('button', { name: 'Joindre contrat.pdf à cette conversation' }).click()
  await expect.poll(() => api.copies).toEqual(['file-1'])
  // La copie attend dans la zone de saisie, prête à partir avec le message.
  await expect(page.locator('.composer-area').getByText('contrat.pdf')).toBeVisible()

  await card.getByRole('button', { name: 'Supprimer ancien.pdf' }).click()
  await expect(card.getByText('ancien.pdf')).toBeVisible()
  await card.getByRole('button', { name: 'Confirmer la suppression de ancien.pdf' }).click()
  await expect(card.getByText('ancien.pdf')).toHaveCount(0)
  expect(api.library.map((item) => item.id)).toEqual(['file-1'])
})
