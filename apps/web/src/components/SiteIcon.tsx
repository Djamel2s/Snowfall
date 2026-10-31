import { useState } from 'react'
import { FileText } from 'lucide-react'
import type { MessageSource } from '../lib/api'
import { hostHue, sourceHost } from '../lib/activity'

/** Domaines sans icône (404) : pas redemandés pendant la session. */
const missing = new Set<string>()

/**
 * Icône d'une source : celle du site, servie par Snowfall (jamais chargée
 * depuis le site ou un service tiers) ; à défaut, l'initiale du site sur une
 * teinte stable. Document interne : icône de fichier.
 */
export default function SiteIcon({ source, size = 14 }: { source: Pick<MessageSource, 'url' | 'name'>; size?: number }) {
  const host = sourceHost(source)
  const [failed, setFailed] = useState(() => (host ? missing.has(host) : false))
  if (!host) {
    return (
      <span className="site-icon site-icon-doc" style={{ width: size, height: size }} aria-hidden="true">
        <FileText size={Math.round(size * 0.72)} />
      </span>
    )
  }
  if (failed) {
    return (
      <span className="site-icon site-icon-letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.62), ['--site-hue' as string]: hostHue(host) }} aria-hidden="true">
        {host[0]!.toUpperCase()}
      </span>
    )
  }
  return (
    <img
      className="site-icon"
      src={`/api/favicons/${encodeURIComponent(host)}`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        missing.add(host)
        setFailed(true)
      }}
    />
  )
}
