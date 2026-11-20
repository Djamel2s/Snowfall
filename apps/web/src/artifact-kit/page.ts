import css from './kit.css?raw'
import js from './kit.js?raw'

/**
 * Maquette autonome (téléchargée) : la feuille et le moteur du kit, et le HTML du
 * modèle comme DONNÉE (bloc JSON, jamais interprété comme du code) que le moteur
 * nettoie avant de l'afficher. Même construction que le cadre /artifact/prototype.html.
 */
export function prototypePage(source: string, title: string) {
  const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
  // « < » échappé : le HTML du modèle ne peut pas fermer le bloc JSON.
  const data = JSON.stringify(source).replace(/</g, '\\u003c')
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escape(title)}</title><style>${css}</style></head><body>` +
    `<script type="application/json" id="sf-source">${data}</script><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
  )
}
