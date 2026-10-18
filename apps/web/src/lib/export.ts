import type { Message } from './api'

// Export d'une conversation (branche affichée), fait dans le navigateur : rien
// de plus ne transite par le serveur.

export type ExportedConversation = {
  format: 'snowfall.conversation'
  version: 1
  title: string
  exportedAt: string
  messages: { role: 'user' | 'assistant'; content: string; createdAt: string; sources?: { n: number; name: string }[] }[]
}

export function toExport(title: string, messages: Message[], now = new Date()): ExportedConversation {
  return {
    format: 'snowfall.conversation',
    version: 1,
    title,
    exportedAt: now.toISOString(),
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.sources?.length ? { sources: message.sources.map((source) => ({ n: source.n, name: source.name })) } : {}),
    })),
  }
}

/** Markdown lisible : un titre par intervenant, les sources en fin de réponse. */
export function toMarkdown(title: string, messages: Message[], labels: { user: string; assistant: string; sources: string }) {
  const parts = [`# ${title.replace(/\n/g, ' ')}`, '']
  for (const message of messages) {
    parts.push(`## ${message.role === 'user' ? labels.user : labels.assistant}`, '', message.content.trim(), '')
    if (message.sources?.length) {
      parts.push(`**${labels.sources}**`, '', ...message.sources.map((source) => `- [${source.n}] ${source.name}`), '')
    }
  }
  return parts.join('\n')
}

/** Nom de fichier sûr, dérivé du titre. */
export function exportFileName(title: string, extension: 'md' | 'json') {
  const base =
    title
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation'
  return `${base}.${extension}`
}

/** Téléchargement d'un texte (Blob local, URL révoquée ensuite). */
export function downloadText(content: string, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Lien d'ouverture d'un partage : le jeton est dans le fragment (#), jamais envoyé au serveur avec l'adresse. */
export const shareUrl = (token: string, origin = window.location.origin) => `${origin}/#partage=${token}`
