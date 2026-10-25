import './prism-manual'
import Prism from 'prismjs'
import 'prismjs/components/prism-markup-templating'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-php'
import 'prismjs/components/prism-ruby'
import 'prismjs/components/prism-kotlin'
import 'prismjs/components/prism-swift'
import 'prismjs/components/prism-diff'
import 'prismjs/components/prism-docker'
import 'prismjs/components/prism-powershell'
import 'prismjs/components/prism-toml'

// Coloration syntaxique par les grammaires de Prism, mais rendue en éléments
// React à partir de ses jetons : aucun HTML n'est jamais produit ni injecté.

export type HighlightToken = { types: string[]; text: string }

const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash',
  console: 'bash', yml: 'yaml', md: 'markdown', html: 'markup', xml: 'markup', svg: 'markup', 'c++': 'cpp', cs: 'csharp', 'c#': 'csharp',
  rb: 'ruby', kt: 'kotlin', dockerfile: 'docker', ps1: 'powershell', ps: 'powershell', golang: 'go', rs: 'rust',
}
/** Au-delà, la coloration coûterait plus qu'elle n'apporte : texte simple. */
const MAX_CODE = 60_000

/** Jetons colorés, ou null : langage inconnu (repli sur la coloration générique). */
export function highlight(code: string, lang: string): HighlightToken[] | null {
  const name = ALIASES[lang] ?? lang
  const grammar = Prism.languages[name]
  if (!grammar || code.length > MAX_CODE) return null
  const out: HighlightToken[] = []
  const walk = (stream: Prism.TokenStream, types: string[]) => {
    if (typeof stream === 'string') return void out.push({ types, text: stream })
    if (Array.isArray(stream)) return stream.forEach((item) => walk(item, types))
    const aliases = Array.isArray(stream.alias) ? stream.alias : stream.alias ? [stream.alias] : []
    walk(stream.content, [...types, stream.type, ...aliases])
  }
  walk(Prism.tokenize(code, grammar), [])
  return out
}
