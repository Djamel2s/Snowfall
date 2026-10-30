import { useState, type ReactNode } from 'react'
import { AlarmClock, Copy, Pencil, ThumbsUp, Waypoints } from 'lucide-react'
import type { Agent } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { AgentAvatar } from './AgentAvatar'
import { TemplateDetail } from './AgentTemplates'
import { useAgentTemplates } from '../hooks/useAgentTemplates'
import { ListEmpty, ListRow, ListRows, ListSection, PanelNew, PanelSearch, RowAction, SectionAction } from './ui/List'

type Props = {
  agents: Agent[]
  activeAgentId: string | null
  currentUserId: string
  /** Nom court du modèle d'un agent (catalogue des fournisseurs). */
  modelLabel: (agent: Agent) => string
  canWrite: boolean
  onStart: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onDuplicate: (agent: Agent) => void
  onCreate?: (() => void) | undefined
  /** Planifier une tâche récurrente avec cet agent. */
  onSchedule?: ((agent: Agent) => void) | undefined
  onOpenGraph: () => void
  onTemplateInstalled: (agentId: string) => void
  onError: (message: string) => void
  /** Tâches planifiées (affichées sous la recherche). */
  schedules?: ReactNode
}

/**
 * Agents (barre latérale), comme l'historique des conversations : « Nouvel
 * agent », une recherche, puis les miens, ceux partagés avec moi, et le
 * catalogue d'agents prêts à l'emploi. Cliquer un agent démarre une conversation.
 */
export default function AgentsPanel(props: Props) {
  const { agents, activeAgentId, currentUserId, modelLabel, canWrite } = props
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const templates = useAgentTemplates(props.onError)
  const template = templates.find((item) => item.id === open)

  if (template) {
    return (
      <div className="list-panel">
        <TemplateDetail
          template={template}
          canInstall={canWrite}
          onBack={() => setOpen(null)}
          onError={props.onError}
          onInstalled={(id) => {
            setOpen(null)
            props.onTemplateInstalled(id)
          }}
        />
      </div>
    )
  }

  const needle = query.trim().toLocaleLowerCase()
  const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle)
  const shown = agents.filter((agent) => matches(`${agent.name} ${modelLabel(agent)}`))
  const mine = shown.filter((agent) => agent.createdBy === currentUserId)
  const shared = shown.filter((agent) => agent.createdBy !== currentUserId)
  const catalog = templates.filter((item) => matches(`${item.name} ${item.tagline}`))

  const agentRow = (agent: Agent) => (
    <ListRow
      key={agent.id}
      icon={<AgentAvatar avatar={agent.avatar} size={22} />}
      title={agent.name}
      subtitle={modelLabel(agent)}
      tooltip={agent.name}
      selected={agent.id === activeAgentId}
      onClick={() => props.onStart(agent)}
      trailing={
        agent.rating ? (
          <span className="list-row-chip ok" title={t('agents.rating', { count: agent.rating.total })}>
            <ThumbsUp size={9} aria-hidden="true" /> {Math.round((agent.rating.up / agent.rating.total) * 100)} %
          </span>
        ) : undefined
      }
      actions={
        <>
          {agent.canEdit && (
            <RowAction label={t('sidebar.editAgent', { name: agent.name })} title={t('common.edit')} onClick={() => props.onEdit(agent)}>
              <Pencil size={12} />
            </RowAction>
          )}
          {props.onSchedule && (
            <RowAction label={t('schedules.new', { name: agent.name })} title={t('schedules.schedule')} onClick={() => props.onSchedule!(agent)}>
              <AlarmClock size={12} />
            </RowAction>
          )}
          {props.onCreate && (
            <RowAction label={t('agents.duplicate', { name: agent.name })} title={t('agents.duplicateShort')} onClick={() => props.onDuplicate(agent)}>
              <Copy size={12} />
            </RowAction>
          )}
        </>
      }
    />
  )

  return (
    <div className="list-panel">
      {props.onCreate && <PanelNew label={t('agents.new')} onClick={props.onCreate} />}
      <PanelSearch value={query} onChange={setQuery} placeholder={t('agents.search')} />
      {props.schedules}

      <ListSection
        label={t('agents.mineTitle')}
        actions={
          agents.length > 0 ? (
            <SectionAction label={t('graph.open')} onClick={props.onOpenGraph}>
              <Waypoints size={14} />
            </SectionAction>
          ) : undefined
        }
      >
        {mine.length ? <ListRows>{mine.map(agentRow)}</ListRows> : <ListEmpty>{needle ? t('agents.noMatch') : t('agents.noneMine')}</ListEmpty>}
      </ListSection>

      {shared.length > 0 && (
        <ListSection label={t('agents.sharedTitle')}>
          <ListRows>{shared.map(agentRow)}</ListRows>
        </ListSection>
      )}

      {catalog.length > 0 && (
        <ListSection label={t('templates.tabCatalog')}>
          <ListRows>
            {catalog.map((item) => (
              <ListRow
                key={item.id}
                icon={<AgentAvatar avatar={item.avatar} size={22} />}
                title={item.name}
                subtitle={item.tagline}
                label={t('templates.open', { name: item.name })}
                tooltip={item.tagline}
                onClick={() => setOpen(item.id)}
                trailing={
                  item.evaluation.measured ? (
                    <span className="list-row-chip ok" title={t('templates.measuredShort')}>
                      {item.evaluation.measured.passed}/{item.evaluation.measured.total}
                    </span>
                  ) : undefined
                }
              />
            ))}
          </ListRows>
        </ListSection>
      )}
    </div>
  )
}
