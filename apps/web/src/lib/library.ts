import type { Agent, LibraryBase, LibraryBaseSummary, Project } from './api'
import type { MessageKey } from './i18n'

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/**
 * Nom d'une base. Sans nom : base reprise d'un agent ou d'un projet (avant la
 * bibliothèque), nommée d'après lui.
 */
export function libraryLabel(base: LibraryBase & Partial<Pick<LibraryBaseSummary, 'usedBy'>>, agents: Pick<Agent, 'id' | 'name'>[], projects: Pick<Project, 'id' | 'name'>[], t: Translate) {
  if (base.name) return base.name
  for (const item of base.usedBy ?? []) {
    const agent = item.kind === 'agent' ? agents.find((candidate) => candidate.id === item.id) : undefined
    if (agent) return t('library.agentDocs', { name: agent.name })
    const project = item.kind === 'project' ? projects.find((candidate) => candidate.id === item.id) : undefined
    if (project) return t('library.projectDocs', { name: project.name })
  }
  return t('library.untitled')
}
