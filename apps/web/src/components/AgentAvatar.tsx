import type { AgentAvatarData, ProviderId } from '../lib/api'
import Alien, { type AlienMood } from './Alien'
import { providerMeta } from '../lib/providers'

export function AgentAvatar({
  avatar,
  size = 32,
  mood = 'idle',
}: {
  avatar: AgentAvatarData
  size?: number
  mood?: AlienMood
}) {
  return (
    <span className={`agent-avatar agent-avatar-${mood}`} style={{ width: size, height: size }}>
      {avatar.kind === 'image' ? (
        <img src={avatar.data} alt="" width={size} height={size} />
      ) : (
        <Alien avatar={avatar} size={size} mood={mood} />
      )}
    </span>
  )
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
