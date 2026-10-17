// Réparation des organigrammes Mermaid écrits par un modèle. L'erreur la plus
// fréquente : un libellé sans guillemets qui contient un caractère réservé,
// par exemple C[Loyer (charges comprises)]. Mermaid lit la parenthèse comme
// le début d'une forme et refuse tout le diagramme.
//
// On met entre guillemets les libellés des nœuds, des liens et des
// sous-graphes. Ce n'est qu'un SECOURS : le cadre essaie d'abord le diagramme
// tel quel, et n'utilise cette version que s'il est invalide.

/** Formes de nœuds : ouverture → fermeture (les plus longues d'abord). */
const SHAPES: [string, string][] = [
  ['(((', ')))'],
  ['((', '))'],
  ['([', '])'],
  ['[[', ']]'],
  ['[(', ')]'],
  ['{{', '}}'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
  ['>', ']'],
]

const ID_CHAR = /[\p{L}\p{N}_]/u
/** Ce qui peut suivre un nœud : fin, espace, classe (:::), lien, « & », « ; ». */
const AFTER_NODE = /^($|[\s:;&~.=<-])/

const quote = (text: string) => `"${text.replace(/"/g, '#quot;')}"`
const isQuoted = (text: string) => /^\s*".*"\s*$/s.test(text)
/** Trapèzes [/…/], [\…\] : la forme est portée par les barres, on n'y touche pas. */
const isTrapezoid = (open: string, text: string) => open === '[' && /^[/\\].*[/\\]$/s.test(text)

function repairStatement(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const char = line[i]!
    // Texte déjà entre guillemets : recopié tel quel.
    if (char === '"') {
      const end = line.indexOf('"', i + 1)
      if (end === -1) return out + line.slice(i)
      out += line.slice(i, end + 1)
      i = end + 1
      continue
    }
    // Libellé de lien : -->|texte|
    if (char === '|') {
      const end = line.indexOf('|', i + 1)
      if (end === -1) return out + line.slice(i)
      const text = line.slice(i + 1, end)
      out += `|${text.trim() && !isQuoted(text) ? quote(text.trim()) : text}|`
      i = end + 1
      continue
    }
    // Identifiant de nœud suivi d'une forme : A[texte], B((texte))…
    if (ID_CHAR.test(char) && (i === 0 || !ID_CHAR.test(line[i - 1]!))) {
      let j = i
      while (j < line.length && ID_CHAR.test(line[j]!)) j++
      const id = line.slice(i, j)
      const shape = SHAPES.find(([open]) => line.startsWith(open, j))
      if (shape) {
        const [open, close] = shape
        const start = j + open.length
        // Fermeture : la première suivie de ce qui peut suivre un nœud.
        let end = line.indexOf(close, start)
        while (end !== -1 && !AFTER_NODE.test(line.slice(end + close.length))) end = line.indexOf(close, end + 1)
        if (end !== -1) {
          const text = line.slice(start, end)
          const keep = !text.trim() || isQuoted(text) || isTrapezoid(open, text)
          out += id + open + (keep ? text : quote(text.trim())) + close
          i = end + close.length
          continue
        }
      }
      out += id
      i = j
      continue
    }
    out += char
    i++
  }
  return out
}

const KEPT = /^\s*(%%|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b|end\s*$)/

/** Version réparée d'un organigramme (graph / flowchart) ; tout autre diagramme est rendu tel quel. */
export function repairMermaid(source: string): string {
  const lines = source.split('\n')
  // En-tête facultatif (--- title: … ---), puis le type de diagramme.
  let first = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    first = end === -1 ? lines.length : end + 1
  }
  while (first < lines.length && (!lines[first]!.trim() || lines[first]!.trim().startsWith('%%'))) first++
  const header = /^\s*(graph|flowchart)\b(\s+[A-Za-z]{2})?\s*;?/.exec(lines[first] ?? '')
  if (!header) return source

  let subgraphs = 0
  return lines
    .map((line, index) => {
      if (index < first || KEPT.test(line)) return line
      if (index === first) return header[0] + repairStatement(line.slice(header[0].length))
      const subgraph = /^(\s*subgraph\s+)(.*)$/.exec(line)
      if (subgraph) {
        const rest = subgraph[2]!.trim().replace(/^([\p{L}\p{N}_]+)\s+\[/u, '$1[')
        // « subgraph id », « subgraph id[titre] » : le titre seul est réparé.
        if (/^[\p{L}\p{N}_]+(\s*\[.*\])?$/u.test(rest)) return subgraph[1] + repairStatement(rest)
        if (isQuoted(rest)) return line
        return `${subgraph[1]}sg${++subgraphs}[${quote(rest)}]`
      }
      return repairStatement(line)
    })
    .join('\n')
}
