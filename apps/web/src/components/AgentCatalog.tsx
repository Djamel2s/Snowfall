import { useMemo, useState } from 'react'
import { BookOpen, Copy, Globe, Pencil, Plug, Plus, Search, SquareTerminal } from 'lucide-react'
import type { Agent, ToolId } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { AgentAvatar, ProviderLogo } from './AgentAvatar'

type Props = {
  agents: Agent[]
  activeAgentId: string | null
  currentUserId: string
  /** Nom court du modèle d'un agent (catalogue des fournisseurs). */
  modelLabel: (agent: Agent) => string
  onStart: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onDuplicate: (agent: Agent) => void
  onCreate?: (() => void) | undefined
}

/** Outils montrés sur la carte : ce qui distingue un agent d'un autre, pas tout. */
const toolIcons: Partial<Record<ToolId, typeof Globe>> = {
  search_knowledge: BookOpen,
  web_search: Globe,
  code_interpreter: SquareTerminal,
  mcp: Plug,
}

/**
 * Catalogue des agents de l'organisation : une grille de cartes (avatar, nom,
 * modèle, outils), une recherche, et le filtre « les miens ». Cliquer une carte
 * démarre une conversation ; modifier et dupliquer apparaissent au survol.
 */
export default function AgentCatalog({ agents, activeAgentId, currentUserId, modelLabel, onStart, onEdit, onDuplicate, onCreate }: Props) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const hasMine = agents.some((agent) => agent.createdBy === currentUserId)
  const hasOthers = agents.some((agent) => agent.createdBy !== currentUserId)

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return agents.filter(
      (agent) =>
        (!mineOnly || agent.createdBy === currentUserId) &&
        (!needle || agent.name.toLocaleLowerCase().includes(needle) || modelLabel(agent).toLocaleLowerCase().includes(needle)),
    )
  }, [agents, query, mineOnly, currentUserId, modelLabel])

  return (
    <div className="agent-catalog">
      {agents.length > 3 && (
        <label className="agent-catalog-search">
          <Search size={13} />
          <input type="search" value={query} placeholder={t('agents.search')} aria-label={t('agents.search')} onChange={(event) => setQuery(event.target.value)} />
        </label>
      )}
      {hasMine && hasOthers && (
        <div className="settings-segmented agent-catalog-filter" role="radiogroup" aria-label={t('agents.filter')}>
          {[false, true].map((mine) => (
            <button key={String(mine)} type="button" role="radio" aria-checked={mineOnly === mine} onClick={() => setMineOnly(mine)}>
              {mine ? t('agents.mine') : t('agents.all')}
            </button>
          ))}
        </div>
      )}

      <div className="agent-grid">
        {onCreate && !query && (
          <button type="button" className="agent-card agent-card-new" onClick={onCreate}>
            <span className="agent-card-plus">
              <Plus size={20} />
            </span>
            <strong>{t('agents.new')}</strong>
          </button>
        )}
        {shown.map((agent) => {
          const tools = agent.tools.filter((tool) => toolIcons[tool])
          return (
            <div key={agent.id} className={`agent-card ${agent.id === activeAgentId ? 'active' : ''}`}>
              <button type="button" className="agent-card-main" title={agent.name} onClick={() => onStart(agent)}>
                <span className="agent-card-avatar">
                  <AgentAvatar avatar={agent.avatar} size={54} />
                </span>
                <strong>{agent.name}</strong>
                <span className="agent-card-model">
                  <ProviderLogo provider={agent.provider} size={11} />
                  <span>{modelLabel(agent)}</span>
                </span>
                {tools.length > 0 && (
                  <span className="agent-card-tools" aria-label={tools.map((tool) => t(`tool.${tool}`)).join(', ')}>
                    {tools.map((tool) => {
                      const Icon = toolIcons[tool]!
                      return <Icon key={tool} size={11} aria-hidden="true" />
                    })}
                  </span>
                )}
              </button>
              <div className="agent-card-actions">
                {agent.canEdit && (
                  <button type="button" aria-label={t('sidebar.editAgent', { name: agent.name })} title={t('common.edit')} onClick={() => onEdit(agent)}>
                    <Pencil size={12} />
                  </button>
                )}
                {onCreate && (
                  <button type="button" aria-label={t('agents.duplicate', { name: agent.name })} title={t('agents.duplicateShort')} onClick={() => onDuplicate(agent)}>
                    <Copy size={12} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {shown.length === 0 && query && <p className="agent-catalog-empty">{t('agents.noMatch')}</p>}
    </div>
  )
}
