import { useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, Check, ChevronRight, CircleAlert, Download, FlaskConical, GraduationCap, Plug, Users } from 'lucide-react'
import { api, type AgentTemplate } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { AgentAvatar } from './AgentAvatar'
import ConnectorLogo from './ConnectorLogo'

/**
 * Catalogue d'agents prêts à l'emploi : chaque modèle dit ce qu'il fait, ce qu'il
 * ne fait pas, ce dont il a besoin, et sa qualité MESURÉE. Installé, c'est un
 * agent à vous, modifiable ; son studio s'ouvre pour y ajouter vos documents.
 */
export default function AgentTemplates({ canInstall, onInstalled, onError }: { canInstall: boolean; onInstalled: (agentId: string) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .listAgentTemplates()
      .then((items) => !cancelled && setTemplates(items))
      .catch((cause: unknown) => !cancelled && onError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [onError])

  const template = templates.find((item) => item.id === open)

  async function install(id: string) {
    setBusy(true)
    onError('')
    try {
      const result = await api.installAgentTemplate(id)
      onInstalled(result.agent.id)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (template) {
    const measured = template.evaluation.measured
    return (
      <section className="template-detail" aria-label={template.name}>
        <button type="button" className="connector-back" onClick={() => setOpen(null)}>
          <ArrowLeft size={14} />
          {t('templates.back')}
        </button>
        <header className="template-head">
          <AgentAvatar avatar={template.avatar} size={52} />
          <div>
            <h3>{template.name}</h3>
            <p>{template.tagline}</p>
          </div>
        </header>

        {/* Qualité mesurée sur un vrai modèle, pas déclarée. */}
        <p className={`template-quality${measured ? '' : ' pending'}`}>
          <FlaskConical size={13} />
          {measured
            ? t('templates.measured', { passed: measured.passed, total: measured.total, model: measured.model })
            : t('templates.notMeasured', { count: template.evaluation.cases })}
        </p>

        <div className="template-block">
          <h4>{t('templates.does')}</h4>
          <ul>
            {template.capabilities.map((item) => (
              <li key={item}>
                <Check size={12} />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="template-block">
          <h4>{t('templates.doesNot')}</h4>
          <ul className="template-limits">
            {template.limits.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="template-block">
          <h4>
            <GraduationCap size={13} />
            {t('templates.skills', { count: template.skills.length })}
          </h4>
          <ul className="template-skills">
            {template.skills.map((skill) => (
              <li key={skill.name}>
                <strong>{skill.name}</strong>
                <small>{skill.description}</small>
              </li>
            ))}
          </ul>
        </div>

        <div className="template-block">
          <h4>
            <BookOpen size={13} />
            {t('templates.knowledge')}
          </h4>
          <p className="settings-hint">{t('templates.knowledgeHint')}</p>
          <ul className="template-limits">
            {template.knowledge.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        {template.connectors.length > 0 && (
          <div className="template-block">
            <h4>
              <Plug size={13} />
              {t('templates.connectors')}
            </h4>
            <div className="template-connectors">
              {template.connectors.map((connector) => (
                <span key={connector.id}>
                  <ConnectorLogo icon={connector.icon} color={connector.color ?? '#475569'} name={connector.name} size={18} />
                  {connector.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {template.team.length > 0 && (
          <div className="template-block">
            <h4>
              <Users size={13} />
              {t('templates.team')}
            </h4>
            <p className="settings-hint">{template.team.map((member) => member.name).join(', ')}</p>
          </div>
        )}

        {template.missingTools.length > 0 && (
          <p className="tool-warning">
            <CircleAlert size={12} />
            {t('templates.missingTools', { tools: template.missingTools.map((tool) => t(`tool.${tool}` as Parameters<typeof t>[0])).join(', ') })}
          </p>
        )}

        {canInstall && (
          <button type="button" className="settings-save connector-primary" disabled={busy} onClick={() => void install(template.id)}>
            <Download size={14} />
            {template.team.length ? t('templates.installTeam', { count: template.team.length + 1 }) : t('templates.install')}
          </button>
        )}
      </section>
    )
  }

  return (
    <div className="template-list">
      <p className="settings-hint">{t('templates.hint')}</p>
      <ul>
        {templates.map((item) => (
          <li key={item.id}>
            <button type="button" className="connector-tile" aria-label={t('templates.open', { name: item.name })} onClick={() => setOpen(item.id)}>
              <AgentAvatar avatar={item.avatar} size={34} />
              <span className="connector-name">
                {item.name}
                <small>{item.tagline}</small>
              </span>
              {item.evaluation.measured && (
                <span className="connector-chip connector-chip-ok" title={t('templates.measuredShort')}>
                  {item.evaluation.measured.passed}/{item.evaluation.measured.total}
                </span>
              )}
              <ChevronRight size={14} className="connector-chevron" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
