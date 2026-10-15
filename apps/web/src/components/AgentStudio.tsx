import { useEffect, useRef, useState } from 'react'
import { Camera, Check, ChevronLeft, Sparkles, Trash2 } from 'lucide-react'
import {
  api,
  type Agent,
  type AgentAvatarData,
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

type Props = {
  agent: Agent | null
  onClose: () => void
  onSaved: (agent: Agent) => void
  onDeleted: (id: string) => void
}

export default function AgentStudio({ agent, onClose, onSaved, onDeleted }: Props) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<ProviderCatalog[] | null>(null)
  const [name, setName] = useState(agent?.name ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [avatar, setAvatar] = useState<AgentAvatarData>(agent?.avatar ?? defaultAlien)
  // Dernier alien composé, conservé si on passe par une photo puis revient.
  const [alien, setAlien] = useState<AlienAvatar>(
    agent?.avatar.kind === 'alien' ? agent.avatar : defaultAlien,
  )
  const [provider, setProvider] = useState<ProviderId | null>(agent?.provider ?? null)
  const [model, setModel] = useState(agent?.model ?? '')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
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
      onSaved(
        await api.saveAgent(
          { name: name.trim(), avatar, instructions: instructions.trim(), provider, model },
          agent?.id,
        ),
      )
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
