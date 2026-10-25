import type { ReactNode } from 'react'
import { Globe, GraduationCap, ImagePlus, Lock, PenLine, Search, ShieldCheck, SquareTerminal } from 'lucide-react'
import { toolAccess, type Agent, type CatalogConnector, type McpServer, type Skill, type ToolId } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { AgentAvatar } from '../AgentAvatar'
import ConnectorLogo from '../ConnectorLogo'

/** Capacités intégrées ; connecteurs et équipe se choisissent directement plus bas. */
const builtIn = ['search_knowledge', 'save_to_knowledge', 'web_search', 'code_interpreter', 'image_generation'] as const
const icons = { search_knowledge: Search, save_to_knowledge: PenLine, web_search: Globe, code_interpreter: SquareTerminal, image_generation: ImagePlus }

export const MAX_DELEGATES = 5
export const MAX_SKILLS = 10

type Props = {
  organizationTools: readonly ToolId[]
  tools: ToolId[]
  onToolsChange: (tools: ToolId[]) => void
  servers: McpServer[]
  catalog: CatalogConnector[]
  agentServers: string[]
  onServersChange: (ids: string[]) => void
  specialists: Agent[]
  delegates: string[]
  onDelegatesChange: (ids: string[]) => void
  skills: Skill[]
  agentSkills: string[]
  onSkillsChange: (ids: string[]) => void
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id])

/**
 * « Ce que l'agent peut faire » : une ligne par capacité, ce qu'elle fait en une
 * phrase, un interrupteur. Les écritures sont signalées (l'agent demande avant).
 */
export default function AgentCapabilities(props: Props) {
  const { t } = useI18n()
  const available = builtIn.filter((id) => props.organizationTools.includes(id))
  const connectorsOn = props.organizationTools.includes('mcp')
  const teamOn = props.organizationTools.includes('delegate') && props.specialists.length > 0
  const logos = new Map(props.catalog.map((entry) => [entry.id, entry]))
  const hiddenSkills = props.agentSkills.filter((id) => !props.skills.some((skill) => skill.id === id))
  const count =
    available.filter((id) => props.tools.includes(id)).length +
    props.agentServers.filter((id) => props.servers.some((server) => server.id === id)).length +
    (teamOn ? props.delegates.length : 0) +
    props.agentSkills.length

  return (
    <section className="studio-capabilities" aria-label={t('studio.can')}>
      <div className="studio-section-head">
        <span>{t('studio.can')}</span>
        <small>{t('studio.canCount', { count })}</small>
      </div>

      {available.length > 0 && (
        <div className="studio-capability-list" role="group" aria-label={t('studio.group.builtIn')}>
          {available.map((id) => {
            const Icon = icons[id]
            return (
              <Capability
                key={id}
                icon={<Icon size={15} />}
                title={t(`studio.cap.${id}`)}
                hint={t(`studio.cap.${id}Hint`)}
                write={toolAccess[id] === 'write'}
                checked={props.tools.includes(id)}
                onChange={() => props.onToolsChange(props.tools.includes(id) ? props.tools.filter((tool) => tool !== id) : [...props.tools, id])}
              />
            )
          })}
        </div>
      )}

      {connectorsOn && (
        <div className="studio-capability-list" role="group" aria-label={t('studio.group.connectors')}>
          <span className="studio-group-label">{t('studio.group.connectors')}</span>
          {props.servers.length === 0 && <p className="settings-hint">{t('studio.noConnectors')}</p>}
          {props.servers.map((server) => {
            const entry = server.catalogId ? logos.get(server.catalogId) : undefined
            const writes = server.tools.some((tool) => tool.access === 'write')
            return (
              <Capability
                key={server.id}
                icon={<ConnectorLogo icon={entry?.icon ?? null} color={entry?.color ?? '#475569'} name={server.name} size={22} />}
                title={server.name}
                hint={writes ? t('studio.connectorToolsWrite', { count: server.tools.length }) : t('studio.connectorTools', { count: server.tools.length })}
                write={writes}
                checked={props.agentServers.includes(server.id)}
                onChange={() => props.onServersChange(toggle(props.agentServers, server.id))}
              />
            )
          })}
        </div>
      )}

      {teamOn && (
        <div className="studio-capability-list" role="group" aria-label={t('studio.group.team')}>
          <span className="studio-group-label">{t('studio.group.team')}</span>
          <p className="settings-hint">{t('studio.teamHint', { max: MAX_DELEGATES })}</p>
          {props.specialists.map((agent) => (
            <Capability
              key={agent.id}
              icon={<AgentAvatar avatar={agent.avatar} size={22} />}
              title={agent.name}
              checked={props.delegates.includes(agent.id)}
              disabled={!props.delegates.includes(agent.id) && props.delegates.length >= MAX_DELEGATES}
              onChange={() => props.onDelegatesChange(toggle(props.delegates, agent.id))}
            />
          ))}
        </div>
      )}

      <div className="studio-capability-list" role="group" aria-label={t('studio.group.skills')}>
        <span className="studio-group-label">{t('studio.group.skills')}</span>
        {props.skills.length === 0 && hiddenSkills.length === 0 ? (
          <p className="settings-hint">{t('studio.noSkills')}</p>
        ) : (
          <p className="settings-hint">{t('studio.skillsHint')}</p>
        )}
        {props.skills.map((skill) => (
          <Capability
            key={skill.id}
            icon={skill.confidential ? <Lock size={15} /> : <GraduationCap size={15} />}
            title={skill.name}
            hint={skill.description}
            checked={props.agentSkills.includes(skill.id)}
            disabled={!props.agentSkills.includes(skill.id) && props.agentSkills.length >= MAX_SKILLS}
            onChange={() => props.onSkillsChange(toggle(props.agentSkills, skill.id))}
          />
        ))}
        {/* Confiée par quelqu'un d'autre et non partagée avec moi : je peux seulement la retirer. */}
        {hiddenSkills.map((id) => (
          <Capability key={id} icon={<GraduationCap size={15} />} title={t('studio.skillHidden')} checked onChange={() => props.onSkillsChange(props.agentSkills.filter((item) => item !== id))} />
        ))}
      </div>
    </section>
  )
}

function Capability({ icon, title, hint, write, checked, disabled, onChange }: { icon: ReactNode; title: string; hint?: string; write?: boolean; checked: boolean; disabled?: boolean; onChange: () => void }) {
  const { t } = useI18n()
  return (
    <label className={`studio-capability${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}>
      <span className="studio-capability-icon">{icon}</span>
      <span className="studio-capability-text">
        <strong>{title}</strong>
        {hint && <small>{hint}</small>}
        {write && (
          <small className="studio-capability-guard">
            <ShieldCheck size={11} />
            {t('studio.askFirst')}
          </small>
        )}
      </span>
      <input type="checkbox" role="switch" aria-label={title} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  )
}
