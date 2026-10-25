import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Eye, PenLine, SlidersHorizontal } from 'lucide-react'
import type { McpDiscoveredTool } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { defaultAccess, presetChoices, suspiciousRead, trustedRead, type ToolChoice, type ToolChoices, type ToolMode as Mode } from './tool-choices'


/**
 * Outils d'un connecteur : trois façons de choisir. L'indication « lecture » vient
 * de l'éditeur (un conseil) : en mode personnalisé, l'administrateur décide outil
 * par outil, en voyant la description et les paramètres que le modèle lira.
 */
export default function ToolPicker({
  tools,
  choices,
  mode,
  onChange,
}: {
  tools: McpDiscoveredTool[]
  choices: ToolChoices
  mode: Mode
  onChange: (next: { mode: Mode; choices: ToolChoices }) => void
}) {
  const { t } = useI18n()
  const [details, setDetails] = useState<string | null>(null)
  const readCount = tools.filter((tool) => tool.supported && trustedRead(tool)).length
  const supported = tools.filter((tool) => tool.supported).length

  const pick = (next: Mode) => onChange({ mode: next, choices: next === 'custom' ? choices : presetChoices(tools, next) })

  return (
    <div className="tool-picker">
      <div className="tool-modes" role="radiogroup" aria-label={t('connectors.toolsMode')}>
        <button type="button" role="radio" aria-checked={mode === 'read'} disabled={readCount === 0} onClick={() => pick('read')}>
          <Eye size={14} />
          <span>
            <strong>{t('connectors.mode.read')}</strong>
            <small>{readCount ? t('connectors.mode.readHint', { count: readCount }) : t('connectors.mode.readNone')}</small>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'all'} onClick={() => pick('all')}>
          <PenLine size={14} />
          <span>
            <strong>{t('connectors.mode.all')}</strong>
            <small>{t('connectors.mode.allHint', { count: supported })}</small>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'custom'} onClick={() => pick('custom')}>
          <SlidersHorizontal size={14} />
          <span>
            <strong>{t('connectors.mode.custom')}</strong>
            <small>{t('connectors.mode.customHint')}</small>
          </span>
        </button>
      </div>

      {/* Modes prédéfinis : ce qui sera approuvé reste visible (et vérifiable) avant d'activer. */}
      {mode !== 'custom' && (
        <div className="tool-included">
          <span>{t('connectors.included')}</span>
          <ul>
            {tools
              .filter((tool) => choices[tool.name]?.selected)
              .map((tool) => (
                <li key={tool.name}>
                  {tool.title ?? tool.name}
                  {choices[tool.name]?.access === 'write' && <small>{t('mcp.write')}</small>}
                </li>
              ))}
          </ul>
          {tools.some((tool) => tool.supported && suspiciousRead(tool)) && (
            <p className="tool-warning">
              <AlertTriangle size={12} />
              {t('connectors.suspiciousSummary', { count: tools.filter((tool) => tool.supported && suspiciousRead(tool)).length })}
            </p>
          )}
          <button type="button" className="connector-link" onClick={() => onChange({ mode: 'custom', choices })}>
            {t('connectors.reviewTools')}
          </button>
        </div>
      )}

      {mode === 'custom' && (
        <ul className="tool-list">
          {tools.map((tool) => {
            const choice = choices[tool.name] ?? { selected: false, access: defaultAccess(tool) }
            const set = (patch: Partial<ToolChoice>) => onChange({ mode, choices: { ...choices, [tool.name]: { ...choice, ...patch } } })
            const params = Object.entries(tool.inputSchema.properties ?? {})
            return (
              <li key={tool.name} className={tool.supported ? '' : 'unsupported'}>
                <div className="tool-line">
                  <label>
                    <input type="checkbox" checked={choice.selected} disabled={!tool.supported} onChange={(event) => set({ selected: event.target.checked })} />
                    <span>{tool.title ?? tool.name}</span>
                  </label>
                  <select aria-label={t('connectors.accessFor', { name: tool.title ?? tool.name })} value={choice.access} disabled={!tool.supported || !choice.selected} onChange={(event) => set({ access: event.target.value as ToolChoice['access'] })}>
                    <option value="read">{t('mcp.read')}</option>
                    <option value="write">{t('mcp.write')}</option>
                  </select>
                  <button type="button" className="icon-button" aria-label={t('connectors.details', { name: tool.title ?? tool.name })} aria-expanded={details === tool.name} onClick={() => setDetails(details === tool.name ? null : tool.name)}>
                    {details === tool.name ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                </div>
                {!tool.supported && <small className="tool-note">{t('mcp.unsupported')}</small>}
                {tool.supported && suspiciousRead(tool) && (
                  <small className="tool-note tool-warning">
                    <AlertTriangle size={11} />
                    {t('connectors.suspiciousRead')}
                  </small>
                )}
                {details === tool.name && (
                  <div className="tool-details">
                    {/* Texte de l'éditeur, tel quel : c'est lui que l'empreinte fige et que le modèle lit. */}
                    {tool.description && <p>{tool.description}</p>}
                    {tool.readOnlyHint && <small>{t('mcp.serverSaysRead')}</small>}
                    {params.length > 0 && (
                      <ul>
                        {params.map(([name, property]) => (
                          <li key={name}>
                            <code>{name}</code>
                            {typeof property?.description === 'string' && property.description ? ` — ${property.description}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
