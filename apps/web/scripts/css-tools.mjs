// Outils partagés des générateurs de thème (clair, couleur de l'interface) :
// lecture des règles CSS et conversions de couleurs. Aucun effet de bord.

export const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g
// Test sans état : un /g garde lastIndex d'une ligne à l'autre et en saute.
export const HAS_COLOR = new RegExp(COLOR.source)

export function parse(color) {
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

export function toHsl({ r, g, b }) {
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

export function fromHsl({ h, s, l }) {
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

export const format = ({ r, g, b, a }) => {
  const [red, green, blue] = [r, g, b].map((value) => Math.round(Math.min(255, Math.max(0, value))))
  return a >= 1 ? `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}` : `rgba(${red}, ${green}, ${blue}, ${+a.toFixed(3)})`
}

/** Règles d'une feuille (un niveau de @media/@supports), commentaires retirés. */
export function rules(css) {
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

