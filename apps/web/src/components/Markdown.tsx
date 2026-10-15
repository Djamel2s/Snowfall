import { memo, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { parseMarkdown, tokenizeCode, type Block, type Inline } from '../lib/markdown'
import { useI18n } from '../lib/i18n'
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
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
            {renderInline(node.children)}
          </a>
        )
    }
  })
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const tokens = useMemo(() => tokenizeCode(text, lang), [text, lang])

  return (
    <div className="md-code">
      <div className="md-code-header">
        <span>{lang || 'code'}</span>
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

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.type) {
      case 'heading': {
        const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
        return <Tag key={index}>{renderInline(block.children)}</Tag>
      }
      case 'paragraph':
        return <p key={index}>{renderInline(block.children)}</p>
      case 'code':
        return <CodeBlock key={index} lang={block.lang} text={block.text} />
      case 'hr':
        return <hr key={index} />
      case 'quote':
        return <blockquote key={index}>{renderBlocks(block.children)}</blockquote>
      case 'list': {
        const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderBlocks(item)}</li>)
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

function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return <div className="markdown">{renderBlocks(blocks)}</div>
}

export default memo(Markdown)
