import type { AgentStep, MessageSource } from './api'
import { hostOf } from './link-trust'

// Activité d'une réponse : ce que l'agent fait (en direct) ou a fait (gardé avec
// la réponse). Fonctions pures, sans React : testées à part.

export type StepKind = 'search' | 'read' | 'knowledge' | 'save' | 'code' | 'mcp' | 'delegate' | 'image' | 'skill' | 'memory' | 'tool'

export function stepKind(name: string): StepKind {
  if (name === 'web_search') return 'search'
  if (name === 'read_webpage') return 'read'
  if (name === 'search_knowledge') return 'knowledge'
  if (name === 'save_to_knowledge') return 'save'
  if (name === 'run_code') return 'code'
  if (name === 'delegate_task') return 'delegate'
  if (name === 'generate_image') return 'image'
  if (name === 'use_skill' || name === 'read_skill_file') return 'skill'
  if (name === 'remember') return 'memory'
  if (name.startsWith('mcp_')) return 'mcp'
  return 'tool'
}

/** Domaine d'une source (sans « www. ») : sites et liens importés. */
export const sourceHost = (source: Pick<MessageSource, 'url'>) => (source.url ? hostOf(source.url) : null)

/** Libellé court d'une source : son domaine, sinon le nom du document. */
export function sourceLabel(source: Pick<MessageSource, 'url' | 'name'>, max = 22) {
  const label = sourceHost(source) ?? source.name
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

/** Durée lisible : « 0,4 s », « 12 s », « 1 min 05 ». */
export function formatDuration(ms: number, locale = 'fr') {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toLocaleString(locale)} s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}`
}

export type StepNode = AgentStep & { children: StepNode[] }

/** Étapes en arbre : celles d'un sous-agent sous l'étape de délégation qui l'a lancé. */
export function stepTree(steps: AgentStep[]): StepNode[] {
  const nodes = new Map<string, StepNode>()
  for (const step of steps) nodes.set(step.id, { ...step, children: [] })
  const roots: StepNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parent ? nodes.get(node.parent) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** Étape en cours la plus profonde (ce que l'agent fait à l'instant), sinon la dernière. */
export function currentStep(steps: AgentStep[]): AgentStep | undefined {
  return [...steps].reverse().find((step) => step.status === 'running') ?? steps.at(-1)
}

/**
 * Provenance : pour chaque source numérotée, l'étape qui l'a trouvée en premier.
 * Les étapes d'un sous-agent ont leur propre numérotation : ignorées.
 */
export function foundBy(steps: AgentStep[]) {
  const map = new Map<number, AgentStep>()
  for (const step of steps) {
    if (step.parent) continue
    for (const n of step.found ?? []) if (!map.has(n)) map.set(n, step)
  }
  return map
}

/** Ce que résume la ligne repliée : recherches, pages lues, documents, autres actions. */
export function activityCounts(steps: AgentStep[]) {
  const counts = { searches: 0, reads: 0, documents: 0, actions: 0, agents: new Set<string>() }
  for (const step of steps) {
    const kind = stepKind(step.name)
    if (kind === 'search') counts.searches++
    else if (kind === 'read') counts.reads++
    else if (kind === 'knowledge') counts.documents++
    else if (kind !== 'delegate') counts.actions++
    if (step.agent) counts.agents.add(step.agent)
  }
  return counts
}

/** Domaines distincts des sources, dans l'ordre (icônes empilées). */
export function uniqueHosts(sources: Pick<MessageSource, 'url'>[], max = 4) {
  const hosts: string[] = []
  for (const source of sources) {
    const host = sourceHost(source)
    if (host && !hosts.includes(host)) hosts.push(host)
    if (hosts.length >= max) break
  }
  return hosts
}

/** Teinte stable d'un domaine (initiale sur fond coloré quand le site n'a pas d'icône). */
export function hostHue(host: string) {
  let hash = 0
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) % 360
  return hash
}

/**
 * Citations d'un texte : « [1] », « [1, 3] », « [1][2] » → numéros, regroupés
 * quand ils se suivent. Ne reconnaît pas un lien Markdown « [texte](…) ».
 */
export const CITATION = /^\[(\d{1,3}(?:\s*,\s*\d{1,3}){0,9})\](?!\()/

export function readCitation(text: string): { numbers: number[]; length: number } | null {
  let rest = text
  let length = 0
  const numbers: number[] = []
  for (;;) {
    const match = CITATION.exec(rest)
    if (!match) break
    for (const part of match[1]!.split(',')) {
      const n = Number(part.trim())
      if (n > 0 && !numbers.includes(n)) numbers.push(n)
    }
    length += match[0].length
    rest = rest.slice(match[0].length)
  }
  return numbers.length ? { numbers, length } : null
}
