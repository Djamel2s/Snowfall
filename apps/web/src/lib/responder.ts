import type { Agent, ModelSelection, ProviderCatalog, ProviderId } from './api'
import { providerLabels } from './provider-labels'

/** Qui répond dans une conversation : un agent, un modèle choisi, ou le modèle par défaut. */
export type Responder =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'model'; provider: ProviderId; model: string; label: string }
  | { kind: 'default' }

/** Choix fait dans le sélecteur (ou mémorisé pour la prochaine conversation). */
export type ResponderChoice = { kind: 'agent'; agentId: string } | { kind: 'model'; selection: ModelSelection }

export type ResponderOption =
  | { key: string; kind: 'agent'; agent: Agent }
  | { key: string; kind: 'model'; provider: ProviderId; model: string; label: string }

const LAST_CHOICE_KEY = 'snowfall:last-responder'

export function modelLabel(providers: ProviderCatalog[], selection: ModelSelection) {
  const provider = providers.find((item) => item.id === selection.provider)
  return provider?.models.find((model) => model.id === selection.model)?.label ?? selection.model
}

/** Résout l'agent / le modèle d'une conversation pour l'affichage. */
export function resolveResponder(
  conversation: { agentId: string | null; model: ModelSelection | null } | undefined,
  agents: Agent[],
  providers: ProviderCatalog[],
  defaultModel: ModelSelection | null,
): Responder {
  const agent = conversation?.agentId ? agents.find((item) => item.id === conversation.agentId) : undefined
  if (agent) return { kind: 'agent', agent }
  const selection = conversation?.model ?? defaultModel
  if (selection) return { kind: 'model', ...selection, label: modelLabel(providers, selection) }
  return { kind: 'default' }
}

/** Fournisseurs proposés : configurés et autorisés par l'organisation. */
export function usableProviders(providers: ProviderCatalog[]) {
  return providers.filter((provider) => provider.available && provider.allowed !== false && provider.models.length > 0)
}

const normalize = (value: string) =>
  value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** Agents d'abord, puis les modèles par fournisseur ; filtrés par la recherche. */
export function responderOptions(agents: Agent[], providers: ProviderCatalog[], query: string): ResponderOption[] {
  const needle = normalize(query.trim())
  const matches = (...values: string[]) => !needle || values.some((value) => normalize(value).includes(needle))

  const options: ResponderOption[] = agents
    .filter((agent) => matches(agent.name))
    .map((agent) => ({ key: `agent:${agent.id}`, kind: 'agent', agent }))

  for (const provider of usableProviders(providers)) {
    for (const model of provider.models) {
      if (!matches(model.label, model.id, providerLabels[provider.id])) continue
      options.push({ key: `model:${provider.id}:${model.id}`, kind: 'model', provider: provider.id, model: model.id, label: model.label })
    }
  }
  return options
}

export function isCurrent(option: ResponderOption, current: Responder) {
  if (option.kind === 'agent') return current.kind === 'agent' && current.agent.id === option.agent.id
  return current.kind === 'model' && current.provider === option.provider && current.model === option.model
}

export function choiceOf(option: ResponderOption): ResponderChoice {
  return option.kind === 'agent'
    ? { kind: 'agent', agentId: option.agent.id }
    : { kind: 'model', selection: { provider: option.provider, model: option.model } }
}

export function readLastChoice(): ResponderChoice | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_CHOICE_KEY) ?? 'null') as ResponderChoice | null
    if (saved?.kind === 'agent' && typeof saved.agentId === 'string') return saved
    if (saved?.kind === 'model' && typeof saved.selection?.provider === 'string' && typeof saved.selection.model === 'string') {
      return saved
    }
  } catch {
    // Préférence illisible : on repart du modèle par défaut.
  }
  return null
}

export function saveLastChoice(choice: ResponderChoice) {
  try {
    localStorage.setItem(LAST_CHOICE_KEY, JSON.stringify(choice))
  } catch {
    // Non mémorisé : sans gravité.
  }
}

/** Mention « @… » juste avant le curseur (début de texte ou après une espace). */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret))
  if (!match) return null
  const query = match[2] ?? ''
  return { start: caret - query.length - 1, query }
}
