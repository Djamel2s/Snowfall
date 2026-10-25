// Markdown minimal (sous-ensemble GFM) transformé en arbre, rendu ensuite en
// éléments React : aucun HTML brut n'est jamais injecté dans la page.
// Volontairement absent : images (une injection de prompt pourrait s'en servir
// pour exfiltrer des données via l'URL) et HTML inline (affiché comme texte).

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' }
  /** Formule LaTeX, rendue en MathML (jamais en HTML brut). */
  | { type: 'math'; tex: string; display: boolean }

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'quote'; children: Block[] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' }
  | { type: 'math'; tex: string }

/** Seuls les liens web et mail sont cliquables (pas de javascript:, data:, file:…). */
export function safeHref(raw: string): string | null {
  const href = raw.trim()
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

// ---- Inline -------------------------------------------------------------

const PUNCTUATION = /[!-/:-@[-`{-~]/
/** Longueur maximale d'une formule (au-delà : texte). */
const MAX_TEX = 2_000
const WORD = /[\p{L}\p{N}]/u
const AUTOLINK = /^https?:\/\/[^\s<>"]*[^\s<>".,:;!?'")\]]/
// Une seule parenthèse imbriquée tolérée (URL Wikipédia) ; classes disjointes
// pour éviter tout retour arrière coûteux sur une entrée malveillante.
const LINK = /^\[([^\]\n]+)\]\(\s*<?([^\s<>()]*(?:\([^\s<>()]*\)[^\s<>()]*)?)>?(?:\s+"[^"\n]*")?\s*\)/

const DELIMITERS = [
  ['**', 'strong'],
  ['__', 'strong'],
  ['~~', 'del'],
  ['*', 'em'],
  ['_', 'em'],
] as const

export function parseInline(source: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ type: 'text', text })
    text = ''
  }

  let i = 0
  while (i < source.length) {
    const char = source[i]!
    const rest = source.slice(i)
    const previous = i > 0 ? source[i - 1]! : ' '

    // Formules : \( … \) et \[ … \] (avant l'échappement, qui les prendrait pour du texte).
    if (char === '\\' && (source[i + 1] === '(' || source[i + 1] === '[')) {
      const close = source[i + 1] === '(' ? '\\)' : '\\]'
      const end = source.slice(0, i + MAX_TEX).indexOf(close, i + 2)
      if (end !== -1 && end > i + 2) {
        flush()
        out.push({ type: 'math', tex: source.slice(i + 2, end).trim(), display: close === '\\]' })
        i = end + 2
        continue
      }
    }

    // $$ … $$ et $ … $ (règles de Pandoc : « 5 $ et 10 $ » reste du texte).
    if (char === '$') {
      const math = inlineDollar(source, i)
      if (math) {
        flush()
        out.push({ type: 'math', tex: math.tex, display: math.display })
        i = math.end
        continue
      }
    }

    if (char === '\\' && i + 1 < source.length && PUNCTUATION.test(source[i + 1]!)) {
      text += source[i + 1]
      i += 2
      continue
    }

    if (char === '\n') {
      flush()
      out.push({ type: 'br' })
      i++
      continue
    }

    if (char === '`') {
      const fence = /^`+/.exec(rest)![0]
      const end = source.indexOf(fence, i + fence.length)
      if (end !== -1) {
        flush()
        out.push({ type: 'code', text: source.slice(i + fence.length, end).replace(/^ (.+) $/, '$1') })
        i = end + fence.length
        continue
      }
    }

    // Image : jamais chargée, affichée comme un simple lien.
    const image = rest.startsWith('![') ? LINK.exec(rest.slice(1)) : null
    const link = image ?? (char === '[' ? LINK.exec(rest) : null)
    if (link) {
      const href = safeHref(link[2]!)
      flush()
      const label = parseInline(link[1]!)
      out.push(...(href ? [{ type: 'link' as const, href, children: label }] : label))
      i += link[0].length + (image ? 1 : 0)
      continue
    }

    if (char === 'h' && !WORD.test(previous)) {
      const auto = AUTOLINK.exec(rest)
      const href = auto && safeHref(auto[0])
      if (auto && href) {
        flush()
        out.push({ type: 'link', href, children: [{ type: 'text', text: auto[0] }] })
        i += auto[0].length
        continue
      }
    }

    const delimiter = DELIMITERS.find(([mark]) => rest.startsWith(mark))
    if (delimiter) {
      const [mark, type] = delimiter
      const after = source[i + mark.length] ?? ' '
      // "_" à l'intérieur d'un mot (snake_case) reste littéral.
      const intraword = mark[0] === '_' && WORD.test(previous)
      if (!intraword && !/\s/.test(after)) {
        const end = findClosing(source, mark, i + mark.length)
        if (end !== -1) {
          flush()
          out.push({ type, children: parseInline(source.slice(i + mark.length, end)) })
          i = end + mark.length
          continue
        }
      }
      text += mark
      i += mark.length
      continue
    }

    text += char
    i++
  }

  flush()
  return out
}

/**
 * $…$ : le premier $ suivi d'autre chose qu'un espace, le second précédé d'autre
 * chose qu'un espace et non suivi d'un chiffre ; jamais sur plusieurs lignes.
 */
function inlineDollar(source: string, at: number): { tex: string; display: boolean; end: number } | null {
  // Fenêtre bornée : un texte piégé (des milliers de « $ ») reste linéaire.
  const scope = source.slice(0, at + MAX_TEX)
  if (scope.startsWith('$$', at)) {
    const end = scope.indexOf('$$', at + 2)
    return end > at + 2 ? { tex: source.slice(at + 2, end).trim(), display: true, end: end + 2 } : null
  }
  const first = source[at + 1]
  if (!first || /\s|\$/.test(first)) return null
  const lineEnd = scope.indexOf('\n', at)
  const limit = lineEnd === -1 ? scope.length : lineEnd
  for (let end = scope.indexOf('$', at + 1); end !== -1 && end < limit; end = scope.indexOf('$', end + 1)) {
    if (source[end - 1] === '\\') continue
    if (/\s/.test(source[end - 1]!) || /\d/.test(source[end + 1] ?? '')) continue
    return { tex: source.slice(at + 1, end), display: false, end: end + 1 }
  }
  return null
}

function findClosing(source: string, mark: string, from: number) {
  let at = source.indexOf(mark, from)
  while (at !== -1) {
    const before = source[at - 1] ?? ' '
    const after = source[at + mark.length] ?? ' '
    const valid =
      at > from &&
      !/\s/.test(before) &&
      // "*" simple ne doit pas fermer sur le début d'un "**".
      !(mark.length === 1 && after === mark) &&
      !(mark[0] === '_' && WORD.test(after))
    if (valid) return at
    at = source.indexOf(mark, at + mark.length)
  }
  return -1
}

// ---- Blocs --------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?/
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/
// Doit contenir un "|" pour ne pas confondre avec un séparateur horizontal "---".
const TABLE_SEPARATOR = /^(?=[^|]*\|)\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const MATH_OPEN = /^ {0,3}(\$\$|\\\[)\s*$/

function startsBlock(line: string) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || MATH_OPEN.test(line)
}

function splitRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (!line.trim()) {
      i++
      continue
    }

    // Bloc de code : un bloc non refermé (réponse en cours) va jusqu'à la fin.
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!)
      i++
      blocks.push({ type: 'code', lang: fence[2]!.toLowerCase(), text: body.join('\n') })
      continue
    }

    // Formule en bloc : $$ ou \[ seuls sur leur ligne, jusqu'à $$ ou \].
    const math = MATH_OPEN.exec(line)
    if (math) {
      const close = math[1] === '$$' ? '$$' : '\\]'
      const body: string[] = []
      i++
      while (i < lines.length && lines[i]!.trim() !== close) body.push(lines[i++]!)
      i++
      blocks.push({ type: 'math', tex: body.join('\n').trim() })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1]!.length, children: parseInline(heading[2]!) })
      i++
      continue
    }

    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]!).map((cell): Align =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null,
      )
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        const cells = splitRow(lines[i++]!)
        rows.push(head.map((_, column) => parseInline(cells[column] ?? '')))
      }
      blocks.push({ type: 'table', align: head.map((_, column) => align[column] ?? null), head: head.map(parseInline), rows })
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && lines[i]!.trim() && (QUOTE.test(lines[i]!) || !startsBlock(lines[i]!))) {
        body.push(lines[i++]!.replace(QUOTE, ''))
      }
      blocks.push({ type: 'quote', children: parseBlocks(body) })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item) {
      const indent = item[1]!.length
      const ordered = /\d/.test(item[2]!)
      const items: Block[][] = []

      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]!)
        if (!current || current[1]!.length !== indent || /\d/.test(current[2]!) !== ordered) break

        const contentIndent = indent + current[2]!.length + 1
        const body = [current[3]!]
        i++

        while (i < lines.length) {
          const next = lines[i]!
          if (!next.trim()) {
            // Ligne vide : l'élément continue seulement si la suite est indentée.
            const following = lines.slice(i + 1).find((candidate) => candidate.trim())
            if (following && following.search(/\S/) >= Math.min(contentIndent, indent + 2)) {
              body.push('')
              i++
              continue
            }
            break
          }
          const nested = next.search(/\S/)
          if (nested >= Math.min(contentIndent, indent + 2)) {
            body.push(next.slice(Math.min(nested, contentIndent)))
            i++
          } else if (!startsBlock(next) && body[body.length - 1]!.trim()) {
            body.push(next.trim()) // continuation paresseuse du paragraphe
            i++
          } else {
            break
          }
        }
        items.push(parseBlocks(body))
      }

      blocks.push({ type: 'list', ordered, start: ordered ? Number.parseInt(item[2]!, 10) : 1, items })
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i]!.trim() && !(paragraph.length && startsBlock(lines[i]!))) {
      if (
        paragraph.length &&
        lines[i]!.includes('|') &&
        i + 1 < lines.length &&
        TABLE_SEPARATOR.test(lines[i + 1]!)
      ) {
        break
      }
      paragraph.push(lines[i++]!.trim())
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }

  return blocks
}

// ---- Coloration syntaxique ---------------------------------------------

export type CodeToken = { kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword'; text: string }

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default del do elif else enum export ' +
    'extends false fn for from func function go if impl import in interface is lambda let match mod mut new ' +
    'nil none not null or package pass private protected pub public raise return self static struct super ' +
    'switch this throw true try type typeof undefined use var void where while with yield ' +
    'select insert update delete into values create table where join on group order by limit and'
  ).split(' '),
)
const HASH_COMMENTS = new Set(['python', 'py', 'bash', 'sh', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'r', 'dockerfile', 'powershell', 'ps1'])

/** Coloration générique (mots-clés, chaînes, nombres, commentaires) : légère et sans dépendance. */
export function tokenizeCode(code: string, lang: string): CodeToken[] {
  const comment = HASH_COMMENTS.has(lang) ? '#[^\\n]*' : lang === 'sql' ? '--[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'
  const pattern = new RegExp(
    `(${comment})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)|([A-Za-z_]\\w*)`,
    'g',
  )
  const tokens: CodeToken[] = []
  let last = 0

  for (const match of code.matchAll(pattern)) {
    const kind: CodeToken['kind'] = match[1]
      ? 'comment'
      : match[2]
        ? 'string'
        : match[3]
          ? 'number'
          : KEYWORDS.has(lang === 'sql' ? match[0].toLowerCase() : match[0])
            ? 'keyword'
            : 'plain'
    if (kind === 'plain') continue
    if (match.index > last) tokens.push({ kind: 'plain', text: code.slice(last, match.index) })
    tokens.push({ kind, text: match[0] })
    last = match.index + match[0].length
  }

  if (last < code.length) tokens.push({ kind: 'plain', text: code.slice(last) })
  return tokens
}
