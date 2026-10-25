// Génère src/theme-light.css à partir des feuilles de style (thème sombre) :
// chaque déclaration de couleur reçoit son équivalent clair, sous
// :root[data-theme="light"], SANS modifier les fichiers d'origine.
//
//   node scripts/generate-light-theme.mjs
//
// Conversion : luminosité inversée, teinte gardée. Les accents vifs restent
// assez foncés pour être lisibles sur fond clair ; les ombres restent sombres.
// Les retouches à la main vont dans src/theme-light-fixes.css (jamais ici).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const SOURCES = ['index.css', 'App.css', 'workspace.css', 'agents.css', 'markdown.css']
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g
// Test sans état : un /g garde lastIndex d'une ligne à l'autre et en saute.
const HAS_COLOR = new RegExp(COLOR.source)
const SHADOWS = new Set(['box-shadow', 'text-shadow', 'filter', 'drop-shadow'])

function parse(color) {
  if (color.startsWith('#')) {
    let hex = color.slice(1)
    if (hex.length <= 4) hex = [...hex].map((char) => char + char).join('')
    const value = (index) => parseInt(hex.slice(index, index + 2), 16)
    return { r: value(0), g: value(2), b: value(4), a: hex.length === 8 ? value(6) / 255 : 1 }
  }
  const parts = color.slice(color.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean)
  const channel = (text) => (text.endsWith('%') ? (parseFloat(text) / 100) * 255 : parseFloat(text))
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
  return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha }
}

function toHsl({ r, g, b }) {
  const [red, green, blue] = [r / 255, g / 255, b / 255]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const light = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: light }
  const delta = max - min
  const s = light > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  const h = max === red ? (green - blue) / delta + (green < blue ? 6 : 0) : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4
  return { h: h / 6, s, l: light }
}

function fromHsl({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 }
}

const format = ({ r, g, b, a }) => {
  const [red, green, blue] = [r, g, b].map((value) => Math.round(Math.min(255, Math.max(0, value))))
  return a >= 1 ? `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}` : `rgba(${red}, ${green}, ${blue}, ${+a.toFixed(3)})`
}

export function lighten(color, property) {
  const rgba = parse(color)
  const hsl = toHsl(rgba)
  // Ombres : restent sombres, un peu plus légères sur fond clair.
  if (SHADOWS.has(property) && hsl.l < 0.35) return format({ ...rgba, a: rgba.a * 0.45 })
  let l = 1 - hsl.l
  let s = hsl.s
  if (hsl.l > 0.8) {
    // Texte clair (même légèrement teinté) → texte sombre, peu saturé.
    l = Math.max(0.1, l)
    s = Math.min(s, 0.35)
  } else if (hsl.s > 0.35 && hsl.l > 0.45) {
    // Accent vif (bleu, violet, vert…) : lisible sur blanc, sans virer au noir.
    l = Math.min(0.5, Math.max(0.3, l + 0.1))
  }
  // Fond très sombre devenu très clair : légère teinte froide gardée.
  return format({ ...fromHsl({ h: hsl.h, s, l }), a: rgba.a })
}

/** Règles d'une feuille (un niveau de @media/@supports), commentaires retirés. */
function rules(css) {
  const out = []
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let index = 0
  const read = (wrapper) => {
    while (index < text.length) {
      const open = text.indexOf('{', index)
      const close = text.indexOf('}', index)
      if (close !== -1 && (open === -1 || close < open)) {
        index = close + 1
        return
      }
      if (open === -1) return
      const head = text.slice(index, open).trim()
      index = open + 1
      if (/^@(media|supports)/.test(head) && !/^@media\s+print\b/.test(head)) {
        read(head)
      } else if (/^@(keyframes|font-face|-webkit-keyframes|media\s+print)/.test(head)) {
        // Blocs imbriqués ignorés (animations, impression déjà en noir sur blanc) : on saute jusqu'à l'accolade fermante.
        let depth = 1
        while (depth && index < text.length) {
          if (text[index] === '{') depth++
          else if (text[index] === '}') depth--
          index++
        }
      } else {
        const end = text.indexOf('}', index)
        out.push({ wrapper, selector: head, body: text.slice(index, end) })
        index = end + 1
      }
    }
  }
  read(null)
  return out
}

function prefix(selector) {
  return selector
    .split(/,(?![^(]*\))/)
    .map((part) => {
      const item = part.trim()
      if (item.startsWith(':root')) return item.replace(':root', ':root[data-theme="light"]')
      if (item.startsWith('html')) return item.replace(/^html/, 'html[data-theme="light"]')
      return `:root[data-theme="light"] ${item}`
    })
    .join(',\n')
}

const blocks = new Map()
let count = 0
for (const file of SOURCES) {
  for (const rule of rules(readFileSync(`${root}${file}`, 'utf8'))) {
    const declarations = rule.body
      .split(';')
      .map((line) => line.trim())
      .filter((line) => line.includes(':') && HAS_COLOR.test(line) && !line.includes('var('))
      .map((line) => {
        COLOR.lastIndex = 0
        const property = line.slice(0, line.indexOf(':')).trim()
        const value = line.slice(line.indexOf(':') + 1).trim()
        count++
        return `  ${property}: ${value.replace(COLOR, (color) => lighten(color, property))};`
      })
    COLOR.lastIndex = 0
    if (!declarations.length) continue
    const key = rule.wrapper ?? ''
    blocks.set(key, [...(blocks.get(key) ?? []), `${prefix(rule.selector)} {\n${declarations.join('\n')}\n}`])
  }
}

const body = [...blocks.entries()].map(([wrapper, items]) => (wrapper ? `${wrapper} {\n${items.join('\n\n')}\n}` : items.join('\n\n'))).join('\n\n')
const output = `/* Thème clair GÉNÉRÉ par scripts/generate-light-theme.mjs (${count} déclarations) : ne pas modifier à la main.\n   Retouches : src/theme-light-fixes.css. */\n\n${body}\n`
// --check (lancé par npm test) : échoue si une feuille a changé sans régénération.
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(`${root}theme-light.css`, 'utf8')
  } catch {
    // Fichier absent : traité comme périmé.
  }
  if (current.replace(/\r\n/g, '\n') !== output) {
    console.error('theme-light.css est périmé : lancez « npm run theme ».')
    process.exit(1)
  }
} else {
  writeFileSync(`${root}theme-light.css`, output)
  console.log(`theme-light.css : ${count} déclarations de couleur converties.`)
}
