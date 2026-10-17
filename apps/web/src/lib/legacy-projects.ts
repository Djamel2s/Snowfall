import { api } from './api'

const LEGACY_PROJECTS_KEY = 'snowfall:projects'

let legacyMigration: Promise<void> | null = null

/**
 * Reprise unique des projets autrefois conservés dans le navigateur : créés
 * côté serveur (chiffrés, RLS) puis retirés du stockage local. Mémorisée au
 * niveau du module pour ne jamais s'exécuter deux fois (StrictMode).
 */
export function migrateLegacyProjects() {
  legacyMigration ??= (async () => {
    const legacy = readLegacyProjects()
    if (legacy.length === 0) return
    if ((await api.listProjects()).length === 0) {
      const known = new Set((await api.listConversations()).map((item) => item.id))
      for (const old of legacy) {
        const created = await api.createProject(old.name)
        for (const conversationId of old.conversationIds.filter((id) => known.has(id))) {
          await api.updateConversation(conversationId, { projectId: created.id }).catch(() => undefined)
        }
      }
    }
    try {
      localStorage.removeItem(LEGACY_PROJECTS_KEY)
    } catch {
      // Rien à nettoyer.
    }
  })().catch(() => undefined)
  return legacyMigration
}

/** Projets autrefois enregistrés dans le navigateur (avant leur passage côté serveur). */
function readLegacyProjects(): { name: string; conversationIds: string[] }[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_PROJECTS_KEY) ?? '[]') as unknown
    if (!Array.isArray(saved)) return []
    return saved
      .filter(
        (item): item is { name: string; conversationIds: string[] } =>
          typeof item?.name === 'string' && Array.isArray(item?.conversationIds),
      )
      .map((item) => ({ name: item.name.slice(0, 80), conversationIds: item.conversationIds.filter((id) => typeof id === 'string') }))
  } catch {
    return []
  }
}
