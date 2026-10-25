import type { AgentAvatarData, ProviderId } from '../lib/api'
import Alien, { type AlienMood } from './Alien'
import { providerMeta } from '../lib/providers'

export function AgentAvatar({
  avatar,
  size = 32,
  mood = 'idle',
  full = false,
}: {
  avatar: AgentAvatarData
  size?: number
  mood?: AlienMood
  full?: boolean
}) {
  return (
    <span className={`agent-avatar agent-avatar-${mood}`} style={{ width: size, height: size }}>
      {avatar.kind === 'image' ? (
        <img src={avatar.data} alt="" width={size} height={size} />
      ) : (
        <Alien avatar={avatar} size={size} mood={mood} full={full} />
      )}
    </span>
  )
}

/** Avatar d'un message d'agent : l'alien en pied, animé ; une photo à la taille du logo (42 px). */
export function MessageAgentAvatar({ avatar, mood = 'idle' }: { avatar: AgentAvatarData; mood?: AlienMood }) {
  return <AgentAvatar avatar={avatar} size={avatar.kind === 'alien' ? 64 : 42} mood={mood} full />
}

export function ProviderLogo({ provider, size = 18 }: { provider: ProviderId; size?: number }) {
  return (
    <img
      src={providerMeta[provider].logo}
      alt=""
      width={size}
      height={size}
      className={`provider-logo provider-logo-${provider}`}
    />
  )
}
