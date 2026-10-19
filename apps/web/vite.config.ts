import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Mermaid n'est jamais chargé par l'application : seulement par le cadre isolé
 * des artifacts. Il est intégré EN LIGNE à /artifact/mermaid.html (variante de
 * public/artifact/frame.html) : dans une iframe d'origine opaque, aucun fichier
 * n'a besoin d'être chargé, donc rien ne peut l'être.
 */
function artifactMermaid(): Plugin {
  const mermaid = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')
  const frame = new URL('./public/artifact/frame.html', import.meta.url)
  const page = () =>
    readFileSync(frame, 'utf8').replace(
      '<body>',
      // Fonction, pas texte : dans un texte de remplacement, « $& », « $' »… seraient
      // interprétés, et le code de Mermaid en contient des centaines.
      // « </script » dans le code fermerait la balise : échappé.
      () => `<body>\n<script>${readFileSync(mermaid, 'utf8').replaceAll('</script', '<\\/script')}</script>`,
    )
  return {
    name: 'snowfall-artifact-mermaid',
    configureServer(server) {
      server.middlewares.use('/artifact/mermaid.html', (_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(page())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'artifact/mermaid.html', source: page() })
    },
  }
}
export default defineConfig({
  plugins: [react(), artifactMermaid()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        // SNOWFALL_API_URL : API d'une pile de test isolée (sinon l'API de développement).
        target: process.env.SNOWFALL_API_URL ?? 'http://127.0.0.1:3001',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})