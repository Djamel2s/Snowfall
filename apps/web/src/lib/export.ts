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
export function exportFileName(title: string, extension: 'md' | 'json' | 'txt' | 'png') {
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

/** Texte brut lisible : Markdown allégé (titres, gras, liens, blocs de code). */
export function plainText(markdown: string) {
  return markdown
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, '$1$2')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => (label && label !== url ? `${label} (${url})` : url))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Export texte : un intervenant par bloc, séparés d'une ligne. */
export function toText(title: string, messages: Message[], labels: { user: string; assistant: string; sources: string }) {
  const parts = [title.replace(/\n/g, ' '), '='.repeat(Math.min(60, Math.max(3, title.length))), '']
  for (const message of messages) {
    parts.push(`${message.role === 'user' ? labels.user : labels.assistant} :`, plainText(message.content), '')
    if (message.sources?.length) parts.push(`${labels.sources} : ${message.sources.map((source) => `[${source.n}] ${source.name}`).join(', ')}`, '')
  }
  return parts.join('\n')
}

/** Découpe un texte en lignes d'au plus `width` (mesure fournie : testable sans navigateur). */
export function wrapLines(text: string, width: number, measure: (value: string) => number) {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word
      if (line.trim() && measure(next.trimEnd()) > width) {
        lines.push(line.trimEnd())
        line = word.trimStart()
      } else {
        line = next
      }
      // Mot plus long que la ligne (même le premier) : coupé au caractère.
      while (measure(line) > width && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && measure(line.slice(0, cut)) > width) cut--
        lines.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

/** Hauteur maximale d'une image (limite des navigateurs autour de 32 000 px). */
export const IMAGE_MAX_HEIGHT = 16_000

/**
 * Image de la conversation (PNG), dessinée sur un canevas : texte seul, fond
 * clair. Trop longue : coupée, avec une mention en bas.
 */
export async function toImage(title: string, messages: Message[], labels: { user: string; assistant: string; cut: string }) {
  const width = 1080
  const padding = 56
  const inner = width - padding * 2
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas indisponible')
  const font = (size: number, weight = 400) => `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`

  type Row = { text: string; size: number; weight: number; color: string; gap: number }
  const rows: Row[] = []
  context.font = font(30, 700)
  for (const line of wrapLines(title, inner, (value) => context.measureText(value).width)) rows.push({ text: line, size: 30, weight: 700, color: '#0b1424', gap: 8 })
  rows.push({ text: '', size: 12, weight: 400, color: '#000', gap: 18 })
  for (const message of messages) {
    rows.push({ text: message.role === 'user' ? labels.user : labels.assistant, size: 17, weight: 700, color: message.role === 'user' ? '#2f5f9e' : '#3a4a60', gap: 8 })
    context.font = font(19)
    for (const line of wrapLines(plainText(message.content), inner, (value) => context.measureText(value).width)) rows.push({ text: line, size: 19, weight: 400, color: '#1b2433', gap: 9 })
    rows.push({ text: '', size: 10, weight: 400, color: '#000', gap: 22 })
  }

  let height = padding
  let shown = 0
  for (const row of rows) {
    if (height + row.size + row.gap > IMAGE_MAX_HEIGHT - padding - 40) break
    height += row.size + row.gap
    shown++
  }
  const cut = shown < rows.length
  canvas.width = width
  canvas.height = height + padding + (cut ? 40 : 0)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.textBaseline = 'top'
  let y = padding
  for (const row of rows.slice(0, shown)) {
    context.font = font(row.size, row.weight)
    context.fillStyle = row.color
    context.fillText(row.text, padding, y)
    y += row.size + row.gap
  }
  if (cut) {
    context.font = font(16, 600)
    context.fillStyle = '#8a3b3b'
    context.fillText(labels.cut, padding, y + 10)
  }
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image impossible'))), 'image/png'))
}

/** Téléchargement d'un fichier binaire (Blob local, URL révoquée ensuite). */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
