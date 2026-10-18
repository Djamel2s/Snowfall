import { createContext, useContext } from 'react'

// Liens dans les réponses : un lien piégé (« cliquez ici », vers un domaine
// d'attaquant, avec des données dans l'adresse) est le dernier canal de fuite
// d'une injection. Un domaine n'est cliquable directement que s'il est déjà
// apparu dans la conversation : écrit par l'utilisateur, ou source citée.
// Sinon, le lien s'affiche avec son domaine, et s'ouvre au second clic.

/** Domaines de confiance pour la conversation affichée (vide : aucun). */
export const LinkTrust = createContext<ReadonlySet<string>>(new Set())

export const useLinkTrust = () => useContext(LinkTrust)

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/gi

/** Nom d'hôte normalisé (sans « www. »), ou null si l'adresse est invalide. */
export function hostOf(href: string) {
  try {
    return new URL(href).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Domaines apparus dans la conversation : messages de l'utilisateur et sources citées. */
export function trustedHosts(messages: { role: string; content: string; sources?: { url: string | null }[] }[]) {
  const hosts = new Set<string>()
  for (const message of messages) {
    if (message.role === 'user') for (const match of message.content.matchAll(URL_IN_TEXT)) addHost(hosts, match[0])
    for (const source of message.sources ?? []) if (source.url) addHost(hosts, source.url)
  }
  return hosts
}

function addHost(hosts: Set<string>, href: string) {
  const host = hostOf(href)
  if (host) hosts.add(host)
}

/** Le lien mène-t-il à un domaine de confiance (ou à Snowfall lui-même) ? */
export function isTrustedLink(href: string, trusted: ReadonlySet<string>, origin = typeof window === 'undefined' ? '' : window.location.origin) {
  if (href.startsWith('mailto:')) return false
  const host = hostOf(href)
  if (!host) return false
  if (origin && hostOf(origin) === host) return true
  return trusted.has(host)
}
