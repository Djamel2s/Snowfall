import { memo, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Code2, Copy, Eye, FileCode2, Network, Shapes, TriangleAlert } from 'lucide-react'
import { artifactKind, artifactTitle, useOpenArtifact, type ArtifactKind } from '../lib/artifacts'
import { parseMarkdown, tokenizeCode, type Block, type Inline } from '../lib/markdown'
import { useI18n } from '../lib/i18n'
import { hostOf, isTrustedLink, useLinkTrust } from '../lib/link-trust'
import '../markdown.css'

// Rendu exclusivement en éléments React : le texte est toujours échappé,
// aucun dangerouslySetInnerHTML.

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.text
      case 'br':
        return <br key={index} />
      case 'code':
        return <code key={index}>{node.text}</code>
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>
      case 'del':
        return <del key={index}>{renderInline(node.children)}</del>
      case 'link':
        return (
          <SafeLink key={index} href={node.href}>
            {renderInline(node.children)}
          </SafeLink>
        )
    }
  })
}

/**
 * Lien d'une réponse : cliquable si son domaine est déjà apparu dans la
 * conversation ; sinon affiché avec son domaine, ouvert au second clic.
 */
function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  const { t } = useI18n()
  const trusted = useLinkTrust()
  const [armed, setArmed] = useState(false)
  if (isTrustedLink(href, trusted)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        {children}
      </a>
    )
  }
  const host = hostOf(href) ?? href
  return (
    <span className="md-link-unverified">
      {children}
      <button
        type="button"
        className={armed ? 'armed' : ''}
        title={armed ? href : t('link.unverified', { host })}
        aria-label={armed ? t('link.openConfirm', { host }) : t('link.unverified', { host })}
        onBlur={() => setArmed(false)}
        onClick={() => {
          if (!armed) return setArmed(true)
          setArmed(false)
          window.open(href, '_blank', 'noopener,noreferrer')
        }}
      >
        <TriangleAlert size={11} aria-hidden="true" />
        {armed ? t('link.open') : host}
      </button>
    </span>
  )
}

/**
 * Artifact (page HTML, SVG, diagramme) : une carte à ouvrir dans le panneau,
 * le code replié (déplié d'office si la question demandait le code).
 */
function ArtifactCard({ lang, text, kind, showCode }: { lang: string; text: string; kind: ArtifactKind; showCode: boolean }) {
  const { t } = useI18n()
  const openArtifact = useOpenArtifact()!
  const [expanded, setExpanded] = useState(showCode)
  const title = artifactTitle(kind, text)
  const Icon = kind === 'mermaid' ? Network : kind === 'svg' ? Shapes : FileCode2
  return (
    <>
      <div className="md-artifact">
        <button type="button" className="md-artifact-open" title={t('artifact.open')} onClick={() => openArtifact({ kind, source: text, title })}>
          <Icon size={16} />
          <span>
            <strong>{title}</strong>
            <small>{t('artifact.open')}</small>
          </span>
        </button>
        <button
          type="button"
          className="md-artifact-code"
          aria-expanded={expanded}
          aria-label={t('artifact.code')}
          title={t('artifact.code')}
          onClick={() => setExpanded(!expanded)}
        >
          <Code2 size={13} />
          <ChevronDown size={12} className={expanded ? 'open' : ''} />
        </button>
      </div>
      {expanded && <CodeBlock lang={lang} text={text} plain />}
    </>
  )
}

function CodeBlock({ lang, text, plain = false, showCode = false }: { lang: string; text: string; plain?: boolean; showCode?: boolean }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const tokens = useMemo(() => tokenizeCode(text, lang), [text, lang])
  // Page HTML, SVG ou diagramme : affichable dans le cadre isolé des artifacts.
  const openArtifact = useOpenArtifact()
  const kind = artifactKind(lang, text)
  if (kind && openArtifact && !plain) return <ArtifactCard lang={lang} text={text} kind={kind} showCode={showCode} />

  return (
    <div className="md-code">
      <div className="md-code-header">
        <span>{lang || 'code'}</span>
        {kind && openArtifact && !plain && (
          <button
            type="button"
            className="md-code-preview"
            aria-label={t('artifact.open')}
            title={t('artifact.open')}
            onClick={() => openArtifact({ kind, source: text, title: artifactTitle(kind, text) })}
          >
            <Eye size={13} />
            {t('artifact.preview')}
          </button>
        )}
        <button
          type="button"
          aria-label={t('markdown.copyCode')}
          title={t('chat.copy')}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            })
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((token, index) =>
            token.kind === 'plain' ? token.text : <span key={index} className={`tok-${token.kind}`}>{token.text}</span>,
          )}
        </code>
      </pre>
    </div>
  )
}

function renderBlocks(blocks: Block[], showCode = false): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case 'heading': {
        const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
        return <Tag key={index}>{renderInline(block.children)}</Tag>
      }
      case 'paragraph':
        return <p key={index}>{renderInline(block.children)}</p>
      case 'code':
        return <CodeBlock key={index} lang={block.lang} text={block.text} showCode={showCode} />
      case 'hr':
        return <hr key={index} />
      case 'quote':
        return <blockquote key={index}>{renderBlocks(block.children, showCode)}</blockquote>
      case 'list': {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderBlocks(item, showCode)}</li>)
        return block.ordered ? (
          <ol key={index} start={block.start}>{items}</ol>
        ) : (
          <ul key={index}>{items}</ul>
        )
      }
      case 'table':
        return (
          <div key={index} className="md-table">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, column) => (
                    <th key={column} style={{ textAlign: block.align[column] ?? undefined }}>{renderInline(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => (
                      <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>{renderInline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

/** showCode : la question demandait le code, les artifacts s'affichent dépliés. */
function Markdown({ source, showCode = false }: { source: string; showCode?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return <div className="markdown">{renderBlocks(blocks, showCode)}</div>
}

export default memo(Markdown)
