import {
  siAirtable,
  siAsana,
  siBox,
  siBuildkite,
  siCalendly,
  siClickup,
  siCloudflare,
  siFigma,
  siGithub,
  siGmail,
  siGoogle,
  siGooglecalendar,
  siGooglechat,
  siGoogledocs,
  siGoogledrive,
  siGooglesheets,
  siGoogleslides,
  siHubspot,
  siHuggingface,
  siJira,
  siLinear,
  siMiro,
  siNeon,
  siNetlify,
  siNotion,
  siPostman,
  siPrisma,
  siSentry,
  siStackoverflow,
  siStripe,
  siSupabase,
  siTodoist,
  siVercel,
  siWolfram,
  siZapier,
  siZoom,
  type SimpleIcon,
} from 'simple-icons'

// Logos des connecteurs : Simple Icons (CC0), dessinés en SVG par React (CSP
// respectée). Les marques qui ont demandé leur retrait de Simple Icons
// (Microsoft, Slack, Canva…) ont une vignette à l'initiale, aux couleurs de la
// marque : on n'utilise pas un logo sans autorisation.
const icons: Record<string, SimpleIcon> = {
  airtable: siAirtable,
  asana: siAsana,
  box: siBox,
  buildkite: siBuildkite,
  calendly: siCalendly,
  clickup: siClickup,
  cloudflare: siCloudflare,
  figma: siFigma,
  github: siGithub,
  gmail: siGmail,
  google: siGoogle,
  googlecalendar: siGooglecalendar,
  googlechat: siGooglechat,
  googledocs: siGoogledocs,
  googledrive: siGoogledrive,
  googlesheets: siGooglesheets,
  googleslides: siGoogleslides,
  hubspot: siHubspot,
  huggingface: siHuggingface,
  jira: siJira,
  linear: siLinear,
  miro: siMiro,
  neon: siNeon,
  netlify: siNetlify,
  notion: siNotion,
  postman: siPostman,
  prisma: siPrisma,
  sentry: siSentry,
  stackoverflow: siStackoverflow,
  stripe: siStripe,
  supabase: siSupabase,
  todoist: siTodoist,
  vercel: siVercel,
  wolfram: siWolfram,
  zapier: siZapier,
  zoom: siZoom,
}

/** Couleur de texte lisible sur une couleur de fond (luminance relative). */
function contrast(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#111111' : '#ffffff'
}

export default function ConnectorLogo({ icon, color, name, size = 28 }: { icon: string | null; color: string; name: string; size?: number }) {
  const found = icon ? icons[icon] : undefined
  const background = found ? `#${found.hex}` : color
  return (
    <span className="connector-logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size} height={size} role="img">
        <rect width="24" height="24" rx="6" fill={background} />
        {found ? (
          <g transform="translate(5 5) scale(0.5833)">
            <path d={found.path} fill={contrast(background)} />
          </g>
        ) : (
          <text x="12" y="16.2" textAnchor="middle" fontSize="11" fontWeight="700" fill={contrast(background)} fontFamily="system-ui, sans-serif">
            {name.slice(0, 1).toUpperCase()}
          </text>
        )}
      </svg>
    </span>
  )
}
