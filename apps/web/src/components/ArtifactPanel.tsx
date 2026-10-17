import { useEffect, useRef, useState } from 'react'
import { Code2, Download, Eye, Play, X } from 'lucide-react'
import { artifactFileName, type OpenedArtifact } from '../lib/artifacts'
import { useI18n } from '../lib/i18n'
import { repairMermaid } from '../lib/mermaid-repair'

type Props = { artifact: OpenedArtifact; onClose: () => void }

/**
 * Panneau d'artifact : le contenu produit par le modèle s'affiche dans une
 * iframe sandbox SANS allow-same-origin (origine opaque : ni cookies, ni API,
 * ni accès à cette page), servie avec sa propre CSP (aucun appel réseau).
 * Une page HTML s'ouvre sans scripts ; « Exécuter » les autorise, à ta demande.
 */
export default function ArtifactPanel({ artifact, onClose }: Props) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'preview' | 'run' | 'code'>('preview')
  const frameRef = useRef<HTMLIFrameElement>(null)
  // Nouveau cadre à chaque contenu ou mode : rien ne persiste d'un rendu à l'autre.
  // Panneau recréé à chaque ouverture (clé dans App) ; cadre neuf à chaque changement de mode.
  const frameKey = `${artifact.opening}:${mode}`
  // Diagramme : image SVG rendue par le cadre (téléchargée telle quelle, jamais affichée ici).
  const [rendered, setRendered] = useState<{ source: string; svg: string } | null>(null)
  const svg = rendered?.source === artifact.source ? rendered.svg : null

  function download() {
    const [content, type] =
      artifact.kind === 'mermaid' && svg
        ? [svg, 'image/svg+xml']
        : artifact.kind === 'html'
          ? [artifact.source, 'text/html']
          : artifact.kind === 'svg'
            ? [artifact.source, 'image/svg+xml']
            : [artifact.source, 'text/plain']
    const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }))
    const link = document.createElement('a')
    link.href = url
    link.download = artifactFileName(artifact, Boolean(svg))
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  useEffect(() => {
    if (mode === 'code') return
    const onMessage = (event: MessageEvent) => {
      // Seul notre cadre peut nous écrire : « prêt », puis l'image rendue d'un diagramme.
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.data?.type === 'artifact-svg') {
        const image: unknown = event.data.svg
        if (artifact.kind === 'mermaid' && typeof image === 'string' && image.length < 5_000_000 && image.startsWith('<svg')) {
          setRendered({ source: artifact.source, svg: image })
        }
        return
      }
      if (event.data?.type !== 'artifact-ready') return
      // Origine opaque : « * » est la seule cible possible ; le contenu n'a rien de secret pour ce cadre.
      frameRef.current?.contentWindow?.postMessage(
        {
          type: 'render',
          kind: artifact.kind,
          source: artifact.source,
          mode: mode === 'run' ? 'run' : 'preview',
          // Secours si le modèle a écrit un libellé invalide (parenthèses sans guillemets…).
          ...(artifact.kind === 'mermaid' ? { fallback: repairMermaid(artifact.source) } : {}),
        },
        '*',
      )
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [artifact, mode, frameKey])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="artifact-panel" aria-label={artifact.title}>
      <header className="artifact-header">
        <strong title={artifact.title}>{artifact.title}</strong>
        <div className="artifact-modes" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'preview'} title={t('artifact.previewHint')} onClick={() => setMode('preview')}>
            <Eye size={13} />
            {t('artifact.preview')}
          </button>
          {artifact.kind === 'html' && (
            <button type="button" role="tab" aria-selected={mode === 'run'} title={t('artifact.runHint')} onClick={() => setMode('run')}>
              <Play size={13} />
              {t('artifact.run')}
            </button>
          )}
          <button type="button" role="tab" aria-selected={mode === 'code'} onClick={() => setMode('code')}>
            <Code2 size={13} />
            {t('artifact.code')}
          </button>
        </div>
        <button
          type="button"
          className="artifact-close"
          aria-label={t('artifact.download')}
          title={t('artifact.download')}
          onClick={download}
        >
          <Download size={14} />
        </button>
        <button type="button" className="artifact-close" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {mode === 'code' ? (
        <pre className="artifact-code">{artifact.source}</pre>
      ) : (
        <iframe
          key={frameKey}
          ref={frameRef}
          className="artifact-frame"
          title={artifact.title}
          src={artifact.kind === 'mermaid' ? '/artifact/mermaid.html' : '/artifact/frame.html'}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow=""
        />
      )}
      {mode === 'run' && <p className="artifact-note">{t('artifact.runNote')}</p>}
    </aside>
  )
}
