import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { Code2, Globe, ImagePlus, MessageSquarePlus, Pencil, Plug, Users, X } from 'lucide-react'
import type { Agent, McpServer, ToolId } from '../lib/api'
import { agentInput, buildAgentGraph, canAddToTeam, neighbors, type GraphLink, type GraphNode } from '../lib/agent-graph'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { AgentAvatar, ProviderLogo } from './AgentAvatar'

type SimNode = GraphNode & SimulationNodeDatum
type SimLink = SimulationLinkDatum<SimNode> & GraphLink

type Props = {
  agents: Agent[]
  servers: McpServer[]
  /** Agents au travail pendant la réponse en cours (ils pulsent). */
  activeAgentIds: ReadonlySet<string>
  reduceMotion: boolean
  onStart: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onAgentSaved: (agent: Agent) => void
  onClose: () => void
  onError: (message: string) => void
}

const RADIUS = { agent: 34, connector: 17, capability: 17 } as const
const CAPABILITY_ICON: Partial<Record<ToolId, typeof Globe>> = { web_search: Globe, code_interpreter: Code2, image_generation: ImagePlus }

/**
 * Carte vivante de l'organisation : agents, équipes, connecteurs, capacités.
 * Survol : voisins allumés, reste estompé. Glisser : déplacer. Maj + glisser
 * (ou depuis l'anneau d'un agent) : l'ajouter à l'équipe d'un autre.
 */
/** Vue qui contient tous les nœuds (marge pour les étiquettes), sans jamais agrandir au-delà de 1. */
function fit(nodes: SimNode[], width: number, height: number) {
  if (!nodes.length || !width || !height) return { x: 0, y: 0, k: 1 }
  const margin = 70
  const xs = nodes.map((node) => node.x ?? 0)
  const ys = nodes.map((node) => node.y ?? 0)
  const [left, right, top, bottom] = [Math.min(...xs) - margin, Math.max(...xs) + margin, Math.min(...ys) - margin, Math.max(...ys) + margin]
  const k = Math.max(0.3, Math.min(1, width / (right - left), height / (bottom - top)))
  return { k, x: width / 2 - ((left + right) / 2) * k, y: height / 2 - ((top + bottom) / 2) * k }
}

export default function AgentGraph({ agents, servers, activeAgentIds, reduceMotion, onStart, onEdit, onAgentSaved, onClose, onError }: Props) {
  const { t } = useI18n()
  const host = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 800, height: 600 })
  const [view, setView] = useState({ x: 0, y: 0, k: 1 })
  // Cadrage automatique (tout le graphe visible, ex. sur mobile) jusqu'au premier zoom ou déplacement.
  const framed = useRef(true)
  const [layout, setLayout] = useState<{ nodes: SimNode[]; links: SimLink[] }>({ nodes: [], links: [] })
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null)
  const nodes = useRef<SimNode[]>([])
  const links = useRef<SimLink[]>([])
  const simulation = useRef<Simulation<SimNode, SimLink> | null>(null)
  const gesture = useRef<{ kind: 'pan' | 'drag' | 'link'; id?: string; startX: number; startY: number; moved: boolean; viewX: number; viewY: number } | null>(null)

  const label = (tool: ToolId) => t(`tool.${tool}`)
  const graph = useMemo(() => buildAgentGraph(agents, servers, label), [agents, servers]) // eslint-disable-line react-hooks/exhaustive-deps

  // Taille du canevas : suit le conteneur.
  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Simulation de forces : positions gardées d'un rendu à l'autre (par identifiant).
  useEffect(() => {
    const previous = new Map(nodes.current.map((node) => [node.id, node]))
    nodes.current = graph.nodes.map((node) => {
      const old = previous.get(node.id)
      return { ...node, x: old?.x ?? size.width / 2 + (Math.random() - 0.5) * 200, y: old?.y ?? size.height / 2 + (Math.random() - 0.5) * 200, vx: old?.vx, vy: old?.vy }
    })
    links.current = graph.links.map((link) => ({ ...link }))
    const sim = forceSimulation<SimNode, SimLink>(nodes.current)
      .force('link', forceLink<SimNode, SimLink>(links.current).id((node) => node.id).distance((link) => (link.kind === 'team' ? 230 : 140)).strength((link) => (link.kind === 'team' ? 0.6 : 0.3)))
      .force('charge', forceManyBody<SimNode>().strength((node) => (node.kind === 'agent' ? -1100 : -320)))
      .force('collide', forceCollide<SimNode>().radius((node) => RADIUS[node.kind] + 34))
      .force('center', forceCenter(size.width / 2, size.height / 2).strength(0.05))
      .alphaDecay(reduceMotion ? 0.2 : 0.03)
    // Léger mouvement permanent (« ça respire »), sauf animations réduites.
    if (!reduceMotion) sim.alphaTarget(0.012)
    let pending = 0
    sim.on('tick', () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        setLayout({ nodes: nodes.current, links: links.current })
        if (framed.current) setView(fit(nodes.current, size.width, size.height))
      })
    })
    simulation.current = sim
    return () => {
      sim.stop()
      cancelAnimationFrame(pending)
    }
  }, [graph, size.width, size.height, reduceMotion])

  const byId = new Map(layout.nodes.map((node) => [node.id, node]))
  const lit = hover ? neighbors(graph.links, hover) : null
  const selectedNode = selected ? byId.get(selected) : undefined
  const selectedAgent = selectedNode?.kind === 'agent' ? selectedNode.agent : null

  /** Coordonnées du graphe sous le pointeur (zoom et déplacement appliqués). */
  function toGraph(event: { clientX: number; clientY: number }) {
    const box = host.current!.getBoundingClientRect()
    return { x: (event.clientX - box.left - view.x) / view.k, y: (event.clientY - box.top - view.y) / view.k }
  }

  function agentAt(point: { x: number; y: number }) {
    return nodes.current.find((node) => node.kind === 'agent' && Math.hypot((node.x ?? 0) - point.x, (node.y ?? 0) - point.y) <= RADIUS.agent + 6)
  }

  function onWheel(event: WheelEvent) {
    const box = host.current!.getBoundingClientRect()
    const k = Math.min(3, Math.max(0.3, view.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)))
    const cx = event.clientX - box.left
    const cy = event.clientY - box.top
    framed.current = false
    setView({ k, x: cx - ((cx - view.x) * k) / view.k, y: cy - ((cy - view.y) * k) / view.k })
  }

  function startNode(event: ReactPointerEvent, node: SimNode, ring = false) {
    event.stopPropagation()
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    const link = node.kind === 'agent' && (ring || event.shiftKey) && node.agent.canEdit
    gesture.current = { kind: link ? 'link' : 'drag', id: node.id, startX: event.clientX, startY: event.clientY, moved: false, viewX: view.x, viewY: view.y }
    if (link) setLinking({ from: node.id, ...toGraph(event) })
  }

  function startPan(event: ReactPointerEvent) {
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    gesture.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, moved: false, viewX: view.x, viewY: view.y }
  }

  function onMove(event: ReactPointerEvent) {
    const current = gesture.current
    if (!current) return
    if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 4) current.moved = true
    // Geste réel (pas un simple toucher) : la vue ne bouge plus sous le doigt.
    if (current.moved) framed.current = false
    if (current.kind === 'pan') {
      setView({ ...view, x: current.viewX + event.clientX - current.startX, y: current.viewY + event.clientY - current.startY })
    } else if (current.kind === 'drag') {
      const node = byId.get(current.id!)
      if (!node) return
      const point = toGraph(event)
      node.fx = point.x
      node.fy = point.y
      simulation.current?.alpha(0.3).restart()
    } else {
      setLinking((link) => (link ? { ...link, ...toGraph(event) } : link))
    }
  }

  async function onUp(event: ReactPointerEvent) {
    const current = gesture.current
    gesture.current = null
    if (!current) return
    if (current.kind === 'drag') {
      const node = byId.get(current.id!)
      if (node) {
        node.fx = null
        node.fy = null
      }
      if (!current.moved) setSelected(current.id!)
      return
    }
    if (current.kind === 'pan') {
      if (!current.moved) setSelected(null)
      return
    }
    setLinking(null)
    const owner = byId.get(current.id!)
    const target = agentAt(toGraph(event))
    if (owner?.kind !== 'agent' || target?.kind !== 'agent') return
    if (!canAddToTeam(owner.agent, target.agent)) return onError(t('graph.cannotLink'))
    await saveTeam(owner.agent, [...(owner.agent.delegates ?? []), target.agent.id])
  }

  async function saveTeam(agent: Agent, delegates: string[]) {
    try {
      onAgentSaved(await api.saveAgent(agentInput(agent, delegates), agent.id))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const dim = (id: string) => (lit && !lit.has(id) ? ' dim' : '')
  const linkPath = (link: SimLink) => {
    const source = link.source as SimNode
    const target = link.target as SimNode
    const sx = source.x ?? 0
    const sy = source.y ?? 0
    const tx = target.x ?? 0
    const ty = target.y ?? 0
    // Lien d'équipe légèrement courbe (A→B et B→A restent distincts).
    if (link.kind !== 'team') return `M${sx},${sy}L${tx},${ty}`
    const mx = (sx + tx) / 2 - (ty - sy) * 0.15
    const my = (sy + ty) / 2 + (tx - sx) * 0.15
    return `M${sx},${sy}Q${mx},${my} ${tx},${ty}`
  }

  return (
    <section className={`agent-graph${reduceMotion ? ' still' : ''}`} aria-label={t('graph.title')}>
      <header className="agent-graph-bar">
        <strong>{t('graph.title')}</strong>
        <span className="agent-graph-hint">{t('graph.hint')}</span>
        <button type="button" className="icon-button" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div
        ref={host}
        className="agent-graph-canvas"
        onWheel={onWheel}
        onPointerDown={startPan}
        onPointerMove={onMove}
        onPointerUp={(event) => void onUp(event)}
        role="group"
        aria-label={t('graph.summary', { agents: agents.length, teams: graph.links.filter((link) => link.kind === 'team').length })}
      >
        <svg width={size.width} height={size.height}>
          <defs>
            <radialGradient id="graph-glow">
              <stop offset="0%" stopColor="rgba(120, 180, 255, .55)" />
              <stop offset="100%" stopColor="rgba(120, 180, 255, 0)" />
            </radialGradient>
            <linearGradient id="graph-team" x1="0" x2="1">
              <stop offset="0%" stopColor="#7fb4ff" />
              <stop offset="100%" stopColor="#c69bff" />
            </linearGradient>
            <marker id="graph-arrow" viewBox="0 0 10 10" refX="40" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0L10,5L0,10z" fill="#a9b8ff" />
            </marker>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {layout.links.map((link) => {
              const source = (link.source as SimNode).id
              const target = (link.target as SimNode).id
              const off = lit && !(lit.has(source) && lit.has(target))
              return (
                <path
                  key={link.id}
                  d={linkPath(link)}
                  className={`graph-link graph-link-${link.kind}${off ? ' dim' : ''}${link.kind === 'team' && (activeAgentIds.has(source.slice(6)) || activeAgentIds.has(target.slice(6))) ? ' live' : ''}`}
                  markerEnd={link.kind === 'team' ? 'url(#graph-arrow)' : undefined}
                />
              )
            })}
            {linking && byId.get(linking.from) && <line className="graph-link-draft" x1={byId.get(linking.from)!.x} y1={byId.get(linking.from)!.y} x2={linking.x} y2={linking.y} />}
            {layout.nodes.map((node) => {
              const r = RADIUS[node.kind]
              const active = node.kind === 'agent' && activeAgentIds.has(node.agent.id)
              const Icon = node.kind === 'connector' ? Plug : node.kind === 'capability' ? (CAPABILITY_ICON[node.tool] ?? Globe) : null
              return (
                <g
                  key={node.id}
                  className={`graph-node graph-node-${node.kind}${dim(node.id)}${active ? ' active' : ''}${selected === node.id ? ' selected' : ''}`}
                  transform={`translate(${node.x ?? 0},${node.y ?? 0})`}
                  onPointerEnter={() => setHover(node.id)}
                  onPointerLeave={() => setHover((current) => (current === node.id ? null : current))}
                  onPointerDown={(event) => startNode(event, node)}
                  // Clavier et lecteurs d'écran : chaque agent est un bouton (Entrée ou Espace ouvre sa fiche).
                  {...(node.kind === 'agent'
                    ? {
                        tabIndex: 0,
                        role: 'button',
                        'aria-label': node.label,
                        'aria-pressed': selected === node.id,
                        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.preventDefault()
                          setSelected((current) => (current === node.id ? null : node.id))
                        },
                      }
                    : { 'aria-hidden': true })}
                >
                  <circle r={r * 2.1} className="graph-node-glow" fill="url(#graph-glow)" />
                  {node.kind === 'agent' && node.agent.canEdit && <circle r={r + 7} className="graph-node-ring" onPointerDown={(event) => startNode(event, node, true)} />}
                  <circle r={r} className="graph-node-core" />
                  <foreignObject x={-r * 0.75} y={-r * 0.75} width={r * 1.5} height={r * 1.5} pointerEvents="none">
                    <div className="graph-node-face">{node.kind === 'agent' ? <AgentAvatar avatar={node.agent.avatar} size={Math.round(r * 1.5)} mood={active ? 'talking' : 'idle'} /> : Icon && <Icon size={14} />}</div>
                  </foreignObject>
                  <text y={r + 16} className="graph-node-label">
                    {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>

        {selectedAgent && (
          <aside className="agent-graph-card" onPointerDown={(event) => event.stopPropagation()}>
            <span className="agent-graph-card-head">
              <AgentAvatar avatar={selectedAgent.avatar} size={36} />
              <span>
                <strong>{selectedAgent.name}</strong>
                <small>
                  <ProviderLogo provider={selectedAgent.provider} size={11} /> {selectedAgent.model}
                </small>
              </span>
            </span>
            <span className="agent-graph-card-label">
              <Users size={12} /> {t('graph.team')}
            </span>
            {(selectedAgent.delegates ?? []).length === 0 ? (
              <small className="agent-graph-card-empty">{t('graph.noTeam')}</small>
            ) : (
              <ul>
                {(selectedAgent.delegates ?? []).map((id) => {
                  const member = agents.find((agent) => agent.id === id)
                  if (!member) return null
                  return (
                    <li key={id}>
                      <AgentAvatar avatar={member.avatar} size={20} />
                      {member.name}
                      {selectedAgent.canEdit && (
                        <button
                          type="button"
                          aria-label={t('graph.removeFromTeam', { name: member.name })}
                          title={t('graph.removeFromTeam', { name: member.name })}
                          onClick={() => void saveTeam(selectedAgent, (selectedAgent.delegates ?? []).filter((item) => item !== id))}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            <span className="agent-graph-card-actions">
              <button type="button" className="chat-actions-primary" onClick={() => onStart(selectedAgent)}>
                <MessageSquarePlus size={14} />
                {t('graph.start')}
              </button>
              {selectedAgent.canEdit && (
                <button type="button" className="chat-actions-item" onClick={() => onEdit(selectedAgent)}>
                  <Pencil size={14} />
                  {t('common.edit')}
                </button>
              )}
            </span>
          </aside>
        )}
      </div>
    </section>
  )
}
