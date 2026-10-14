import type { AgentAvatarData, ProviderId } from '../lib/api'
import Alien from './Alien'
import { providerMeta } from '../lib/providers'

export function AgentAvatar({ avatar, size = 32 }: { avatar: AgentAvatarData; size?: number }) {
  return (
    <span className="agent-avatar" style={{ width: size, height: size }}>
      {avatar.kind === 'image' ? (
        <img src={avatar.data} alt="" width={size} height={size} />
      ) : (
        <Alien avatar={avatar} size={size} />
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
