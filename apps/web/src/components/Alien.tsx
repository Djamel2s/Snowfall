import { useId } from 'react'
import type { AlienAvatar } from '../lib/api'
import { alienPalette } from '../lib/alien'

// Petit alien façon figurine vinyle. Calques nommés (alien-head, alien-eyes,
// alien-arm-*, alien-body, alien-legs) animables séparément en CSS.

const EYE_TILT = 32

function Eye({ eyes, side, id, glow }: { eyes: AlienAvatar['eyes']; side: 'left' | 'right'; id: string; glow: string }) {
  const closed = eyes === 'happy' || (eyes === 'wink' && side === 'right')
  const transform = `translate(${side === 'left' ? 33.5 : 66.5} 39)${side === 'right' ? ' scale(-1 1)' : ''}`

  if (closed) {
    return (
      <path
        transform={`${transform} rotate(12)`}
        d="M-9 3 Q0 -7 9 3"
        fill="none"
        stroke="#1a1220"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
    )
  }

  const round = eyes === 'round'
  const ry = eyes === 'sleepy' ? 4.8 : round ? 10 : 9
  const rx = round ? 10 : 13.2
  return (
    <g transform={`${transform} rotate(${round ? 0 : EYE_TILT}) translate(0 ${eyes === 'sleepy' ? 2 : 0})`}>
      <ellipse rx={rx} ry={ry} fill={`url(#eye-${id})`} />
      <ellipse cy={ry * 0.45} rx={rx * 0.62} ry={ry * 0.32} fill={glow} opacity=".32" />
      {eyes === 'sparkle' ? (
        <>
          <path transform={`translate(${-rx * 0.3} ${-ry * 0.25}) rotate(${-EYE_TILT}) scale(1.5)`} d={STAR} fill="#fff" />
          <path transform={`translate(${rx * 0.35} ${ry * 0.1}) rotate(${-EYE_TILT}) scale(.75)`} d={STAR} fill="#fff" opacity=".8" />
        </>
      ) : (
        <>
          <ellipse cx={-rx * 0.35} cy={-ry * 0.42} rx={rx * 0.26} ry={ry * 0.2} fill="#fff" opacity=".88" />
          <circle cx={rx * 0.32} cy={-ry * 0.1} r={Math.min(1.3, ry * 0.25)} fill="#fff" opacity=".6" />
        </>
      )}
    </g>
  )
}

/** Étoile à quatre branches (reflets « sparkle »). */
const STAR = 'M0 -3 Q.5 -.5 3 0 Q.5 .5 0 3 Q-.5 .5 -3 0 Q-.5 -.5 0 -3 Z'

function BackAccessory({ accessory }: { accessory: AlienAvatar['accessory'] }) {
  if (accessory !== 'antenna') return null
  return (
    <g className="alien-accessory">
      {[1, -1].map((dir) => (
        <g key={dir} transform={dir === -1 ? 'translate(100 0) scale(-1 1)' : undefined}>
          <path d="M41 9 Q37 2 32 -0.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="31" cy="-1" r="3.2" fill="#ffe28a" />
          <circle cx="30" cy="-2" r="1.1" fill="#fff" opacity=".8" />
        </g>
      ))}
    </g>
  )
}

function FrontAccessory({ accessory }: { accessory: AlienAvatar['accessory'] }) {
  switch (accessory) {
    case 'headset':
      return (
        <g className="alien-accessory">
          <path d="M17 30 C16 1 84 1 83 30" fill="none" stroke="#3b4458" strokeWidth="3.4" strokeLinecap="round" />
          <rect x="11.5" y="24" width="9" height="15" rx="4.5" fill="#3b4458" />
          <rect x="79.5" y="24" width="9" height="15" rx="4.5" fill="#3b4458" />
          <rect x="13.5" y="27" width="5" height="9" rx="2.5" fill="#8fb3ff" />
          <rect x="81.5" y="27" width="5" height="9" rx="2.5" fill="#8fb3ff" />
          <path d="M17 38 Q19 50 31 52" fill="none" stroke="#3b4458" strokeWidth="2" strokeLinecap="round" />
          <circle cx="32" cy="52" r="2.2" fill="#8fb3ff" />
        </g>
      )
    case 'bow':
      return (
        <g className="alien-accessory" transform="translate(70 13) rotate(22)">
          <path d="M0 0 L-9 -6 Q-11.5 0 -9 6 Z M0 0 L9 -6 Q11.5 0 9 6 Z" fill="#ff7aa8" strokeLinejoin="round" stroke="#ff7aa8" strokeWidth="1.5" />
          <circle r="2.8" fill="#ff5c93" />
        </g>
      )
    case 'crown':
      return (
        <g className="alien-accessory">
          <path d="M39 9.5 L40.5 -1 L45.5 4.5 L50 -3.5 L54.5 4.5 L59.5 -1 L61 9.5 Q50 7 39 9.5 Z" fill="#ffd36e" stroke="#e2a136" strokeWidth="1" strokeLinejoin="round" />
          <circle cx="50" cy="5" r="1.6" fill="#ff7aa8" />
        </g>
      )
    case 'flower':
      return (
        <g className="alien-accessory" transform="translate(29 15)">
          {[0, 72, 144, 216, 288].map((angle) => (
            <ellipse key={angle} cy="-4.6" rx="3.2" ry="4.4" fill="#fff" transform={`rotate(${angle})`} />
          ))}
          <circle r="2.8" fill="#ffd36e" />
        </g>
      )
    case 'cap':
      return (
        <g className="alien-accessory">
          <path d="M27.5 14 C28.5 0 71.5 0 72.5 14 Q50 9.5 27.5 14 Z" fill="#e05a6f" />
          <path d="M63 12.5 Q77 8.5 88 14.5 Q76 17.5 63 15.5 Z" fill="#bf4258" />
          <circle cx="50" cy="2.6" r="1.6" fill="#bf4258" />
        </g>
      )
    case 'halo':
      return (
        <g className="alien-accessory">
          <ellipse cx="50" cy="-0.5" rx="15" ry="3.6" fill="none" stroke="#ffe28a" strokeWidth="4" opacity=".35" />
          <ellipse cx="50" cy="-0.5" rx="15" ry="3.6" fill="none" stroke="#ffe28a" strokeWidth="2.2" />
        </g>
      )
    case 'helmet':
      return (
        <g className="alien-accessory">
          <ellipse cx="50" cy="61.5" rx="12" ry="3.6" fill="#c9d4e6" />
          <ellipse cx="50" cy="33" rx="39" ry="33.5" fill="#cfe6ff" fillOpacity=".1" stroke="#dcebff" strokeOpacity=".75" strokeWidth="1.6" />
          <path d="M22 22 Q28 8 42 3.5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" opacity=".6" />
        </g>
      )
    default:
      return null
  }
}

/** Mini soucoupe qui flotte à côté de la tête. */
function Ufo() {
  return (
    <g className="alien-accessory alien-ufo">
      <ellipse cx="80" cy="4.5" rx="4.4" ry="4" fill="#a8e6ff" opacity=".9" />
      <ellipse cx="80" cy="7.1" rx="10" ry="3.2" fill="#c9d4e6" />
      <ellipse cx="80" cy="6.3" rx="10" ry="1.4" fill="#fff" opacity=".45" />
      {[73.5, 80, 86.5].map((cx) => (
        <circle key={cx} cx={cx} cy="7.9" r=".9" fill="#ffe28a" />
      ))}
    </g>
  )
}

export default function Alien({ avatar, size = 40 }: { avatar: AlienAvatar; size?: number }) {
  const id = useId().replace(/:/g, '')
  const tone = alienPalette[avatar.color]
  // Petites tailles (listes, messages) : cadrage sur la tête pour garder les yeux lisibles.
  const viewBox = size < 56 ? '12 -3 76 76' : '-2 -4 104 104'
  const limb = { fill: 'none', strokeLinecap: 'round' as const }

  return (
    <svg width={size} height={size} viewBox={viewBox} aria-hidden="true" className="alien" style={{ color: tone.base }}>
      <defs>
        <radialGradient id={`skin-${id}`} cx=".36" cy=".28" r=".8">
          <stop offset="0" stopColor={tone.light} />
          <stop offset=".45" stopColor={tone.base} />
          <stop offset="1" stopColor={tone.shade} />
        </radialGradient>
        <linearGradient id={`eye-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#07050b" />
          <stop offset=".7" stopColor="#1d1320" />
          <stop offset="1" stopColor="#3a2433" />
        </linearGradient>
      </defs>

      <ellipse cx="50" cy="97.5" rx="15" ry="2.2" fill="#000" opacity=".28" />

      <g className="alien-legs">
        <path d="M46.5 85 L46 95 M53.5 85 L54 95" {...limb} stroke={tone.shade} strokeWidth="4.4" />
        <path d="M46.5 85 L46 95 M53.5 85 L54 95" {...limb} stroke={tone.base} strokeWidth="3.2" />
        <ellipse cx="45" cy="96" rx="3.4" ry="1.7" fill={tone.base} />
        <ellipse cx="55" cy="96" rx="3.4" ry="1.7" fill={tone.base} />
      </g>

      {(['left', 'right'] as const).map((side) => (
        // Le miroir est sur un groupe interne : la transformation CSS des
        // animations remplacerait sinon l'attribut transform.
        <g key={side} className={`alien-arm-${side}`}>
          <g transform={side === 'right' ? 'translate(100 0) scale(-1 1)' : undefined}>
            <path d="M44 70 Q38.5 76 37.5 85" {...limb} stroke={tone.shade} strokeWidth="3.8" />
            <path d="M44 70 Q38.5 76 37.5 85" {...limb} stroke={tone.base} strokeWidth="2.7" />
            <circle cx="37.4" cy="86" r="1.9" fill={tone.base} />
          </g>
        </g>
      ))}

      <path d="M47 58 L53 58 L52.4 69 L47.6 69 Z" fill={tone.shade} />
      <path
        className="alien-body"
        d="M50 66 C57 66 60.5 71 59.5 78 C58.5 85 55 88.5 50 88.5 C45 88.5 41.5 85 40.5 78 C39.5 71 43 66 50 66 Z"
        fill={`url(#skin-${id})`}
      />

      {avatar.accessory === 'scarf' && (
        <g className="alien-accessory">
          <path d="M39.5 61.5 Q50 68.5 60.5 61.5 L61.5 66 Q50 73 38.5 66 Z" fill="#e05a6f" />
          <path d="M54.5 67.5 L58.5 77 L54 77.5 L51.5 69 Z" fill="#bf4258" />
        </g>
      )}
      {avatar.accessory === 'tie' && (
        <g className="alien-accessory">
          <path d="M48.3 66.5 L51.7 66.5 L51.1 69.3 L48.9 69.3 Z" fill="#26395a" />
          <path d="M48.9 69.3 L51.1 69.3 L52.6 77.5 L50 80.5 L47.4 77.5 Z" fill="#33508a" />
        </g>
      )}

      <g className="alien-head">
        <BackAccessory accessory={avatar.accessory} />
        <path
          d="M50 6 C70 6 84 17 84 32 C84 47 64 61 50 62 C36 61 16 47 16 32 C16 17 30 6 50 6 Z"
          fill={`url(#skin-${id})`}
        />
        <ellipse cx="35" cy="16" rx="9" ry="4.2" fill="#fff" opacity=".5" transform="rotate(-24 35 16)" />
        <ellipse cx="61" cy="11.5" rx="3" ry="1.4" fill="#fff" opacity=".3" />
        <g className="alien-eyes">
          <Eye eyes={avatar.eyes} side="left" id={id} glow={tone.base} />
          <Eye eyes={avatar.eyes} side="right" id={id} glow={tone.base} />
        </g>
        <FrontAccessory accessory={avatar.accessory} />
      </g>
      {avatar.accessory === 'ufo' && <Ufo />}
    </svg>
  )
}
