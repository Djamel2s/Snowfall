import { defineConfig, devices } from '@playwright/test'

// Parcours sur la VRAIE pile (Keycloak, API, Postgres), lancé par
// scripts/e2e-real.mjs qui monte une pile jetable et fournit E2E_ORIGIN.
// Pas de serveur ici : l'interface et l'API tournent déjà.
const browser = process.env.CI ? {} : { channel: 'msedge' as const }

export default defineConfig({
  testDir: './e2e-real',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_ORIGIN,
    locale: 'fr-FR',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'reel', use: { ...devices['Desktop Chrome'], ...browser, viewport: { width: 1366, height: 860 } } }],
})
