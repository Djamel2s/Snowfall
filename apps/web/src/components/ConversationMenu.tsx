import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FileImage, FileJson, FileText, FileType, Link2, Printer, Share, Trash2 } from 'lucide-react'
import { api, type Message, type ShareLink } from '../lib/api'
import { downloadBlob, downloadText, exportFileName, shareUrl, toExport, toImage, toMarkdown, toText } from '../lib/export'
import { formatDate, useI18n } from '../lib/i18n'

type Props = {
  conversationId: string
  title: string
  messages: Message[]
  canShare: boolean
  onError: (message: string) => void
}

const durations = [1, 7, 30] as const

/**
 * Menu « … » de la conversation : partager (lien interne, expirant, révocable)
 * et exporter (Markdown, JSON). Un panneau léger sous le bouton, pas une fenêtre.
 */
export default function ConversationMenu({ conversationId, title, messages, canShare, onError }: Props) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const [days, setDays] = useState<(typeof durations)[number]>(7)
  const [links, setLinks] = useState<ShareLink[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    if (canShare) {
      api
        .listShares(conversationId)
        .then((items) => !cancelled && setLinks(items))
        .catch(() => undefined)
    }
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      cancelled = true
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open, canShare, conversationId])

  async function copy(link: ShareLink) {
    await navigator.clipboard?.writeText(shareUrl(link.token)).catch(() => undefined)
    setCopied(link.id)
    setTimeout(() => setCopied((current) => (current === link.id ? null : current)), 1600)
  }

  async function create() {
    setBusy(true)
    try {
      const link = await api.createShare(conversationId, days)
      setLinks((current) => [link, ...current])
      await copy(link)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(link: ShareLink) {
    try {
      await api.deleteShare(link.id)
      setLinks((current) => current.filter((item) => item.id !== link.id))
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const labels = { user: t('export.user'), assistant: t('export.assistant'), sources: t('export.sources') }

  return (
    <div className="chat-actions" ref={root}>
      <button type="button" className="icon-button" aria-label={t('menu.conversation')} title={t('menu.conversation')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Share size={17} />
      </button>
      {open && (
        <div className="chat-actions-panel" role="group" aria-label={t('menu.conversation')}>
          {canShare && (
            <section aria-label={t('share.title')}>
              <h4>{t('share.title')}</h4>
              <p className="settings-hint">{t('share.hint')}</p>
              <div className="chat-actions-row">
                <div className="settings-segmented" role="radiogroup" aria-label={t('share.duration')}>
                  {durations.map((value) => (
                    <button key={value} type="button" role="radio" aria-checked={days === value} onClick={() => setDays(value)}>
                      {t('share.days', { count: value })}
                    </button>
                  ))}
                </div>
                <button type="button" className="chat-actions-primary" disabled={busy} onClick={() => void create()}>
                  <Link2 size={14} />
                  {t('share.create')}
                </button>
              </div>
              {links.length > 0 && (
                <ul className="share-links">
                  {links.map((link) => (
                    <li key={link.id}>
                      <span>{t('share.until', { date: formatDate(link.expiresAt, locale) })}</span>
                      <button type="button" aria-label={t('share.copy')} title={t('share.copy')} onClick={() => void copy(link)}>
                        {copied === link.id ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                      <button type="button" aria-label={t('share.revoke')} title={t('share.revoke')} onClick={() => void revoke(link)}>
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <section aria-label={t('export.title')}>
            <h4>{t('export.title')}</h4>
            <div className="chat-actions-row">
              <button type="button" className="chat-actions-item" onClick={() => downloadText(toMarkdown(title, messages, labels), 'text/markdown', exportFileName(title, 'md'))}>
                <FileText size={14} />
                Markdown
              </button>
              <button
                type="button"
                className="chat-actions-item"
                onClick={() => downloadText(JSON.stringify(toExport(title, messages), null, 2), 'application/json', exportFileName(title, 'json'))}
              >
                <FileJson size={14} />
                JSON
              </button>
              <button type="button" className="chat-actions-item" onClick={() => downloadText(toText(title, messages, labels), 'text/plain', exportFileName(title, 'txt'))}>
                <FileType size={14} />
                {t('export.text')}
              </button>
              <button
                type="button"
                className="chat-actions-item"
                onClick={() => {
                  // PDF : l'impression du navigateur (« Enregistrer au format PDF »), mise en page dédiée.
                  setOpen(false)
                  setTimeout(() => window.print(), 50)
                }}
              >
                <Printer size={14} />
                PDF
              </button>
              <button
                type="button"
                className="chat-actions-item"
                onClick={() =>
                  void toImage(title, messages, { ...labels, cut: t('export.imageCut') })
                    .then((blob) => downloadBlob(blob, exportFileName(title, 'png')))
                    .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
                }
              >
                <FileImage size={14} />
                {t('export.image')}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
