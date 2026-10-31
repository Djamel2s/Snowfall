import type { AgentStep, MessageSource } from './api'
import { activityCounts, sourceHost, stepKind } from './activity'
import type { MessageKey } from './i18n'

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/** Une phrase par étape : ce que fait (ou a fait) l'agent, avec sa requête ou son site. */
export function stepSentence(step: AgentStep, t: Translate, consulted: Map<number, MessageSource>) {
  const query = (step.summary ?? '').slice(0, 120)
  switch (stepKind(step.name)) {
    case 'search':
      return query ? t('activity.search', { query }) : t('agent.webSearch')
    case 'read': {
      const page = step.found?.map((n) => consulted.get(n)).find(Boolean)
      const host = page ? sourceHost(page) : null
      return host ? t('activity.read', { host }) : t('activity.readUnknown')
    }
    case 'knowledge':
      return query ? t('activity.knowledge', { query }) : t('agent.searchKnowledge')
    case 'save':
      return t('activity.save')
    case 'code':
      return t('activity.code')
    case 'mcp':
      return t('activity.mcp', { name: step.name.slice(4).replace(/_/g, ' ') })
    case 'delegate':
      return query ? t('activity.delegateTo', { name: query }) : t('activity.delegate')
    case 'image':
      return t('activity.image')
    case 'skill':
      return t('activity.skill')
    case 'memory':
      return t('activity.memory')
    default:
      return t('activity.tool', { name: step.name.replace(/_/g, ' ') })
  }
}

/** Détail sous la phrase : titre de la page lue, ou requête d'une action. */
export function stepDetail(step: AgentStep) {
  const kind = stepKind(step.name)
  if (kind === 'search' || kind === 'knowledge' || kind === 'delegate') return null
  return step.summary ?? null
}

const plural = (t: Translate, base: 'searches' | 'reads' | 'documents' | 'actions' | 'agents', count: number) =>
  count ? t(`activity.${base}.${count === 1 ? 'one' : 'many'}` as MessageKey, { count }) : null

/** Résumé de la ligne repliée : « 2 recherches · 3 pages lues · 1 spécialiste ». */
export function activitySummaryText(steps: AgentStep[], t: Translate) {
  const counts = activityCounts(steps)
  return [
    plural(t, 'searches', counts.searches),
    plural(t, 'reads', counts.reads),
    plural(t, 'documents', counts.documents),
    plural(t, 'actions', counts.actions),
    plural(t, 'agents', counts.agents.size),
  ]
    .filter(Boolean)
    .join(' · ')
}
