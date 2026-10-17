import { defineConfig, devices } from '@playwright/test'

// Tests d'écran : l'interface réelle (Vite) dans un vrai navigateur, l'API
// remplacée par des réponses fictives (e2e/mock-api.ts). Ils vérifient ce que
// voit l'utilisateur, sur bureau et sur mobile ; la sécurité de l'API est
// testée côté API.
//
// En local : le navigateur Edge installé (aucun téléchargement).
// En CI : Chromium (npx playwright install chromium).
const PORT = 5179
const browser = process.env.CI ? {} : { channel: 'msedge' as const }

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'bureau', use: { ...devices['Desktop Chrome'], ...browser, viewport: { width: 1366, height: 860 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...browser } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
