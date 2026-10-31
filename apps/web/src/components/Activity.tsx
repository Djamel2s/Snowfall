import { useEffect, useMemo, useState } from 'react'
import {
  Ban,
  Check,
  ChevronDown,
  FileSearch,
  Globe,
  GraduationCap,
  ImagePlus,
  LoaderCircle,
  PenLine,
  Plug,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { AgentStep, MessageSource } from '../lib/api'
import { currentStep, formatDuration, sourceLabel, stepKind, stepTree, uniqueHosts, type StepKind, type StepNode } from '../lib/activity'
import { activitySummaryText, stepDetail, stepSentence } from '../lib/activity-text'
import { useI18n } from '../lib/i18n'
import ApprovalCard from './ApprovalCard'
import SiteIcon from './SiteIcon'

const ICONS: Record<StepKind, LucideIcon> = {
  search: Globe,
  read: FileSearch,
  knowledge: Search,
  save: PenLine,
  code: SquareTerminal,
  mcp: Plug,
  delegate: Users,
  image: ImagePlus,
  skill: GraduationCap,
  memory: Sparkles,
  tool: Wrench,
}

const MAX_FOUND = 6

type Props = {
  steps: AgentStep[]
  /** Réponse en cours : la ligne dit ce que fait l'agent à l'instant. */
  live?: boolean
  startedAt?: number | undefined
  endedAt?: number | undefined
  /** Sources citées par la réponse (numéros mis en avant dans le fil). */
  sources?: MessageSource[] | undefined
  /** Toutes les sources consultées. */
  consulted?: MessageSource[] | undefined
  onDecide?: (approvalId: string, approved: boolean) => Promise<void>
}

/** Secondes écoulées, rafraîchies chaque seconde pendant la réponse. */
function useElapsed(from: number | undefined, live: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  return from ? Math.max(0, now - from) : 0
}

/**
 * Ce que fait l'agent : en direct, une phrase (« Recherche « … » », « Lecture
 * de lemonde.fr ») ; ensuite, une ligne discrète (« Travaillé pendant 12 s »)
 * qui se déplie en fil complet : chaque étape, sa durée, ce
 * qu'elle a trouvé (cité ou non), les spécialistes consultés, les validations
 * et les contenus suspects signalés. Les demandes de validation restent
 * toujours visibles.
 */
export default function Activity({ steps, live = false, startedAt, endedAt, sources = [], consulted = [], onDecide }: Props) {
  const { t, locale } = useI18n()
  // Replié par défaut, en direct comme après : la ligne dit déjà ce qui se passe.
  const [open, setOpen] = useState(false)
  const first = startedAt ?? steps.find((step) => step.startedAt)?.startedAt
  const elapsed = useElapsed(first, live)
  const lookup = useMemo(() => {
    const map = new Map<number, MessageSource>()
    for (const source of consulted) map.set(source.n, source)
    for (const source of sources) map.set(source.n, source)
    return map
  }, [sources, consulted])
  const cited = useMemo(() => new Set(sources.map((source) => source.n)), [sources])
  const tree = useMemo(() => stepTree(steps), [steps])
  const waiting = steps.filter((step) => step.status === 'running' && step.approval)
  const flagged = steps.some((step) => step.flagged)

  if (!steps.length) return null
  const now = currentStep(steps)
  const duration = live ? elapsed : first && endedAt ? endedAt - first : 0
  const hosts = uniqueHosts([...sources, ...consulted])

  return (
    <div className={`activity ${live ? 'live' : ''} ${open ? 'open' : ''}`}>
      <button type="button" className="activity-head" aria-expanded={open} title={open ? t('activity.collapse') : t('activity.expand')} onClick={() => setOpen(!open)}>
        {live ? (
          <span className="activity-now" aria-live="polite">
            {now ? stepSentence(now, t, lookup) : t('activity.live')}
          </span>
        ) : (
          <>
            {flagged && <ShieldAlert size={13} className="activity-warn" aria-label={t('activity.flagged')} />}
            <span className="activity-label" title={activitySummaryText(steps, t)}>
              {duration > 0 ? t('activity.workedFor', { time: formatDuration(duration, locale) }) : t('activity.title')}
            </span>
          </>
        )}
        {hosts.length > 0 && (
          <span className="activity-hosts" aria-hidden="true">
            {hosts.map((host) => (
              <SiteIcon key={host} source={{ url: `https://${host}/`, name: host }} size={14} />
            ))}
          </span>
        )}
        {live && duration > 0 && <span className="activity-duration">{formatDuration(duration, locale)}</span>}
        <ChevronDown size={13} className="activity-chevron" />
      </button>

      {open && (
        <ol className="activity-timeline" aria-label={t('agent.steps')}>
          {tree.map((node) => (
            <StepItem key={node.id} node={node} lookup={lookup} cited={cited} />
          ))}
        </ol>
      )}

      {onDecide &&
        waiting.map((step) => (
          <div key={step.id} className="activity-approval">
            <ApprovalCard approval={step.approval!} onDecide={onDecide} />
          </div>
        ))}
    </div>
  )
}

function StepItem({ node, lookup, cited }: { node: StepNode; lookup: Map<number, MessageSource>; cited: Set<number> }) {
  const { t, locale } = useI18n()
  const kind = stepKind(node.name)
  const Icon = ICONS[kind]
  const detail = stepDetail(node)
  // Numéros d'un sous-agent : sa propre numérotation, sans lien avec les sources de la réponse.
  const found = node.parent ? [] : (node.found ?? []).map((n) => lookup.get(n)).filter((source): source is MessageSource => Boolean(source))
  const shown = found.slice(0, MAX_FOUND)
  const time = node.startedAt && node.endedAt ? formatDuration(node.endedAt - node.startedAt, locale) : ''
  return (
    <li className={`activity-step ${node.status}`}>
      <span className="activity-dot" aria-hidden="true">
        {node.status === 'running' && node.approval ? <ShieldCheck size={11} /> : node.status === 'running' ? <LoaderCircle size={11} className="spin" /> : <Icon size={11} />}
      </span>
      <div className="activity-body">
        <div className="activity-line">
          {node.agent && <span className="activity-agent">{node.agent}</span>}
          <span className="activity-text">{stepSentence(node, t, lookup)}</span>
          {time && <span className="activity-time">{time}</span>}
        </div>
        {detail && <div className="activity-detail">{detail}</div>}
        {shown.length > 0 && (
          <div className="activity-found">
            {shown.map((source) => (
              <span key={source.n} className={`activity-source ${cited.has(source.n) ? 'cited' : ''}`} title={cited.has(source.n) ? t('activity.cited', { n: source.n }) : t('activity.notCited')}>
                <SiteIcon source={source} size={12} />
                {sourceLabel(source, 26)}
                {cited.has(source.n) && <span className="activity-source-n">{source.n}</span>}
              </span>
            ))}
            {found.length > shown.length && <span className="activity-source more">{t('activity.more', { count: found.length - shown.length })}</span>}
          </div>
        )}
        {(node.flagged || node.approved || node.status === 'denied' || node.status === 'error') && (
          <div className="activity-badges">
            {node.flagged && (
              <span className="activity-badge warn">
                <ShieldAlert size={10} />
                {t('activity.flagged')}
              </span>
            )}
            {node.approved && (
              <span className="activity-badge ok">
                <ShieldCheck size={10} />
                {t('activity.approved')}
              </span>
            )}
            {node.status === 'denied' && (
              <span className="activity-badge muted">
                <Ban size={10} />
                {t('activity.denied')}
              </span>
            )}
            {node.status === 'error' && (
              <span className="activity-badge bad">
                <TriangleAlert size={10} />
                {t('activity.failed')}
              </span>
            )}
          </div>
        )}
        {node.children.length > 0 && (
          <ol className="activity-children">
            {node.children.map((child) => (
              <StepItem key={child.id} node={child} lookup={lookup} cited={cited} />
            ))}
          </ol>
        )}
      </div>
      {node.status === 'done' && !node.children.length && kind !== 'delegate' && <Check size={11} className="activity-done" aria-hidden="true" />}
    </li>
  )
}
