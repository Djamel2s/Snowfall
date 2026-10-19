import { useEffect, useRef, useState } from 'react'
import { Camera, Check, ChevronLeft, Globe, ImagePlus, PenLine, Plug, Search, ShieldCheck, Sparkles, SquareTerminal, Trash2, Users } from 'lucide-react'
import {
  api,
  toolAccess,
  toolIds,
  type ToolId,
  type Agent,
  type AgentAvatarData,
  type AgentParameters,
  type McpServer,
  type AlienAvatar,
  type ProviderCatalog,
  type ProviderId,
} from '../lib/api'
import { defaultAlien } from '../lib/alien'
import { toAvatarDataUrl } from '../lib/image'
import { providerMeta } from '../lib/providers'
import { useI18n } from '../lib/i18n'
import { AgentAvatar, ProviderLogo } from './AgentAvatar'
import AlienEditor from './AlienEditor'
import ModelSelect from './ModelSelect'
import KnowledgePanel from './KnowledgePanel'
import AgentQuality from './AgentQuality'
import { emptyKnowledgeDraft, submitKnowledgeDraft, type KnowledgeDraft } from '../lib/knowledge-draft'

type Props = {
  agent: Agent | null
  /** Agents de l'organisation : spécialistes que celui-ci pourra consulter. */
  agents?: Agent[]
  /** Message à afficher à l'ouverture (documents refusés juste après la création). */
  notice?: string
  onClose: () => void
  /** notice : l'agent est créé mais des documents ont échoué ; le studio reste ouvert. */
  onSaved: (agent: Agent, notice?: string) => void
  onDeleted: (id: string) => void
}

export default function AgentStudio({ agent, agents = [], notice, onClose, onSaved, onDeleted }: Props) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<ProviderCatalog[] | null>(null)
  const [name, setName] = useState(agent?.name ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  // Instructions enregistrées côté serveur (une amélioration appliquée les change).
  const [savedInstructions, setSavedInstructions] = useState(agent?.instructions ?? '')
  const [avatar, setAvatar] = useState<AgentAvatarData>(agent?.avatar ?? defaultAlien)
  // Dernier alien composé, conservé si on passe par une photo puis revient.
  const [alien, setAlien] = useState<AlienAvatar>(
    agent?.avatar.kind === 'alien' ? agent.avatar : defaultAlien,
  )
  const [provider, setProvider] = useState<ProviderId | null>(agent?.provider ?? null)
  const [model, setModel] = useState(agent?.model ?? '')
  const [tools, setTools] = useState<ToolId[]>(agent?.tools ?? ['search_knowledge'])
  // Outils activés par l'organisation : l'auteur choisit parmi eux.
  const [organizationTools, setOrganizationTools] = useState<readonly ToolId[]>(toolIds)
  // Serveurs MCP approuvés par l'admin, et ceux confiés à l'agent.
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [agentMcp, setAgentMcp] = useState<string[]>(agent?.mcpServers ?? [])
  const [agentDelegates, setAgentDelegates] = useState<string[]>(agent?.delegates ?? [])
  const specialists = agents.filter((item) => item.id !== agent?.id)
  // Réglages des réponses (créativité, longueur) ; non réglés : ceux du fournisseur.
  const [parameters, setParameters] = useState<AgentParameters>(agent?.parameters ?? {})
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState(notice ?? '')
  // Nouvel agent : documents en attente, envoyés juste après la création.
  const [draft, setDraft] = useState<KnowledgeDraft>(emptyKnowledgeDraft)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listModels()
      .then((providers) => {
        if (cancelled) return
        setCatalog(providers)
        // Nouvel agent : premier fournisseur disponible présélectionné.
        if (!agent) {
          const first = providers.find((item) => item.available && item.allowed !== false)
          if (first) {
            setProvider(first.id)
            setModel(first.models[0]?.id ?? '')
          }
        }
      })
      .catch(() => !cancelled && setError(t('studio.modelsUnavailable')))
    return () => {
      cancelled = true
    }
  }, [agent, t])

  useEffect(() => {
    let cancelled = false
    api
      .getOrganization()
      // Outils activés par l'organisation ET fournis par la plateforme.
      .then((organization) => {
        if (cancelled) return
        const available = organization.settings.tools.filter((id) => (organization.platformTools ?? toolIds).includes(id))
        setOrganizationTools(available)
        if (available.includes('mcp')) {
          api
            .listMcpServers()
            .then((servers) => !cancelled && setMcpServers(servers.filter((server) => server.status === 'approved')))
            .catch(() => undefined)
        }
      })
      // Réglages illisibles : on montre tout, le serveur filtre à l'enregistrement.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const providerModels = catalog?.find((item) => item.id === provider)?.models ?? []

  function updateAlien(patch: Partial<AlienAvatar>) {
    const next = { ...alien, ...patch }
    setAlien(next)
    setAvatar(next)
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return
    try {
      setAvatar({ kind: 'image', data: await toAvatarDataUrl(file) })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('studio.invalidImage'))
    }
  }

  async function save() {
    if (!provider || !model || !name.trim()) return
    setSaving(true)
    setError('')
    try {
      const saved = await api.saveAgent(
        { name: name.trim(), avatar, instructions: instructions.trim(), provider, model, tools: tools.filter((id) => organizationTools.includes(id)), mcpServers: tools.includes('mcp') ? agentMcp : [], delegates: tools.includes('delegate') ? agentDelegates : [], parameters },
        agent?.id,
      )
      setSavedInstructions(saved.instructions)
      if (agent || (draft.items.length === 0 && !draft.confidential)) {
        onSaved(saved)
        return
      }
      const failures = await submitKnowledgeDraft(api, 'agents', saved.id, draft, t('knowledge.failed.generic'))
      onSaved(saved, failures.length ? `${t('knowledge.draftFailed')} ${failures.join(' · ')}` : undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('studio.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!agent) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      await api.deleteAgent(agent.id)
      onDeleted(agent.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('studio.deleteFailed'))
    }
  }

  const isAlien = avatar.kind === 'alien'
  const providers =
    catalog ??
    (['mistral', 'openai', 'anthropic', 'google', 'local'] as const).map((id) => ({
      id,
      available: false,
      models: [],
    }))

  return (
    <form
      className="agent-studio"
      aria-label={agent ? t('studio.edit') : t('studio.create')}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <header className="studio-header">
        <button type="button" className="studio-icon" aria-label={t('common.back')} title={t('common.back')} onClick={onClose}>
          <ChevronLeft size={17} />
        </button>
        {agent?.canEdit && (
          <button
            type="button"
            className={`studio-icon studio-delete ${confirmDelete ? 'armed' : ''}`}
            aria-label={confirmDelete ? t('studio.confirmDelete') : t('common.delete')}
            title={confirmDelete ? t('common.confirm') : t('common.delete')}
            onClick={() => void remove()}
            onBlur={() => setConfirmDelete(false)}
          >
            <Trash2 size={15} />
          </button>
        )}
      </header>

      <div className="studio-stage">
        <div className="studio-halo" />
        <AgentAvatar avatar={avatar} size={92} />
      </div>

      <div className="studio-mode" role="tablist">
        <button type="button" role="tab" aria-selected={isAlien} title="Alien" onClick={() => setAvatar(alien)}>
          <Sparkles size={14} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={avatar.kind === 'image'}
          title={t('studio.photo')}
          onClick={() => fileRef.current?.click()}
        >
          <Camera size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            void onPhoto(event.target.files?.[0])
            event.target.value = ''
          }}
        />
      </div>

      {isAlien && <AlienEditor value={alien} onChange={updateAlien} />}

      <input
        className="studio-name"
        aria-label={t('studio.name')}
        placeholder={t('studio.name')}
        value={name}
        maxLength={40}
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />

      <div className="provider-grid" role="radiogroup" aria-label={t('studio.provider')}>
        {providers.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={provider === item.id}
            aria-label={providerMeta[item.id].label}
            disabled={!item.available || item.allowed === false}
            className="provider-tile"
            title={
              !item.available
                ? t('studio.notConfigured', { provider: providerMeta[item.id].label })
                : item.allowed === false
                  ? t('studio.notAllowed', { provider: providerMeta[item.id].label })
                  : providerMeta[item.id].label
            }
            onClick={() => {
              setProvider(item.id)
              setModel(item.models[0]?.id ?? '')
              // Confidentiel exige un modèle local : on ne garde pas le choix ailleurs.
              if (item.id !== 'local' && draft.confidential) setDraft({ ...draft, confidential: false })
            }}
          >
            <ProviderLogo provider={item.id} size={20} />
          </button>
        ))}
      </div>

      {provider && providerModels.length > 0 && (
        <ModelSelect provider={provider} models={providerModels} value={model} onChange={setModel} />
      )}

      <textarea
        className="studio-instructions"
        aria-label={t('studio.instructionsLabel')}
        placeholder={t('studio.instructions')}
        value={instructions}
        maxLength={4000}
        rows={5}
        onChange={(event) => setInstructions(event.target.value)}
      />

      {organizationTools.length > 0 && (
        <div className="studio-tools" role="group" aria-label={t('studio.tools')}>
          {organizationTools.map((id) => {
            const Icon = id === 'search_knowledge' ? Search : id === 'web_search' ? Globe : id === 'code_interpreter' ? SquareTerminal : id === 'mcp' ? Plug : id === 'delegate' ? Users : id === 'image_generation' ? ImagePlus : PenLine
            const write = toolAccess[id] === 'write'
            return (
              <button
                key={id}
                type="button"
                className="studio-tool"
                aria-pressed={tools.includes(id)}
                title={write ? t('tool.approvalRequired') : t(`tool.${id}`)}
                onClick={() => setTools(tools.includes(id) ? tools.filter((tool) => tool !== id) : [...tools, id])}
              >
                <Icon size={13} />
                {t(`tool.${id}`)}
                {write && <ShieldCheck size={12} className="studio-tool-guard" />}
              </button>
            )
          })}
        </div>
      )}

      {tools.includes('mcp') && organizationTools.includes('mcp') && mcpServers.length > 0 && (
        <div className="studio-tools" role="group" aria-label={t('studio.mcpServers')}>
          {mcpServers.map((server) => (
            <button
              key={server.id}
              type="button"
              className="studio-tool"
              aria-pressed={agentMcp.includes(server.id)}
              title={server.tools.map((tool) => tool.title ?? tool.name).join(' · ')}
              onClick={() => setAgentMcp(agentMcp.includes(server.id) ? agentMcp.filter((id) => id !== server.id) : [...agentMcp, server.id])}
            >
              <Plug size={13} />
              {server.name}
              {server.tools.some((tool) => tool.access === 'write') && <ShieldCheck size={12} className="studio-tool-guard" />}
            </button>
          ))}
        </div>
      )}

      {tools.includes('delegate') && organizationTools.includes('delegate') && specialists.length > 0 && (
        <div className="studio-tools" role="group" aria-label={t('studio.delegates')}>
          {specialists.map((item) => (
            <button
              key={item.id}
              type="button"
              className="studio-tool"
              aria-pressed={agentDelegates.includes(item.id)}
              disabled={!agentDelegates.includes(item.id) && agentDelegates.length >= 5}
              onClick={() => setAgentDelegates(agentDelegates.includes(item.id) ? agentDelegates.filter((id) => id !== item.id) : [...agentDelegates, item.id])}
            >
              <Users size={13} />
              {item.name}
            </button>
          ))}
        </div>
      )}

      <div className="studio-parameters" role="group" aria-label={t('studio.answers')}>
        <span className="studio-parameters-label">{t('studio.creativity')}</span>
        <div className="settings-segmented" role="radiogroup" aria-label={t('studio.creativity')}>
          {([undefined, 'precise', 'balanced', 'creative'] as const).map((value) => (
            <button
              key={value ?? 'auto'}
              type="button"
              role="radio"
              aria-checked={parameters.creativity === value}
              onClick={() =>
                setParameters((current) => {
                  const next = { ...current }
                  if (value) next.creativity = value
                  else delete next.creativity
                  return next
                })
              }
            >
              {t(`studio.creativity.${value ?? 'auto'}`)}
            </button>
          ))}
        </div>
        <span className="studio-parameters-label">{t('studio.length')}</span>
        <div className="settings-segmented" role="radiogroup" aria-label={t('studio.length')}>
          {(['complete', 'concise'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={(parameters.length ?? 'complete') === value} onClick={() => setParameters({ ...parameters, length: value })}>
              {t(`studio.length.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {agent ? (
        <KnowledgePanel kind="agents" ownerId={agent.id} />
      ) : (
        <KnowledgePanel kind="agents" draft={draft} onDraftChange={setDraft} confidentialAllowed={provider === 'local'} />
      )}

      {/* Qualité : auteur ou administrateur d'un agent déjà créé. */}
      {agent?.canEdit && (
        <AgentQuality
          agentId={agent.id}
          instructions={savedInstructions}
          dirty={instructions.trim() !== savedInstructions.trim()}
          onApplied={(next) => {
            setSavedInstructions(next)
            setInstructions(next)
          }}
        />
      )}

      {error && <p className="studio-error" role="alert">{error}</p>}

      <button
        type="submit"
        className="studio-save"
        disabled={saving || !name.trim() || !provider || !model}
      >
        <Check size={16} />
        {agent ? t('common.save') : t('common.create')}
      </button>
    </form>
  )
}
