// Génère src/theme-accent.css : la couleur de l'interface choisie par
// l'organisation (Administration › Identité), SANS modifier les feuilles
// d'origine.
//
//   node scripts/generate-accent-theme.mjs [--check]
//
// Chaque couleur d'accent (bleus et lavandes : teinte 185–265°, assez saturée)
// devient hsl(teinte + décalage, saturation × facteur, MÊME luminosité, même
// opacité). Le décalage et le facteur sont deux variables posées sur <html> par
// l'application ; sans couleur choisie (pas d'attribut data-accent), aucune règle
// ne s'applique : l'interface reste exactement celle d'origine.
// Les fonds bleu nuit suivent aussi (toute l'ambiance prend la couleur).
// Restent telles quelles, volontairement : les couleurs qui ont un sens (vert
// « prêt », orange « attention », rouge « erreur »), celles des agents, le noir
// et le blanc purs, les gris neutres.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COLOR, HAS_COLOR, parse, rules, toHsl } from './css-tools.mjs'

const root = fileURLToPath(new URL('../src/', import.meta.url))
// Thème sombre (feuilles d'origine), puis thème clair (généré et retouches).
const DARK = ['index.css', 'App.css', 'workspace.css', 'agents.css', 'markdown.css']
const LIGHT = ['theme-light.css', 'theme-light-fixes.css']
/** Teinte de référence du bleu de Snowfall : le décalage se calcule depuis elle. */
export const ACCENT_REFERENCE_HUE = 210

/**
 * Couleur à teinter ? Bleu ou lavande (même peu saturée : gris ardoise) : accents, aussi les
 * fonds bleu nuit (fond, panneaux, cartes) et les textes clairs bleutés, pour
 * que l'ambiance entière suive. Restent tels quels : le noir et le blanc purs,
 * les gris neutres (saturation faible) et toutes les autres teintes.
 */
export function isAccent(color) {
  const { h, s, l } = toHsl(parse(color))
  const hue = h * 360
  return hue >= 185 && hue <= 265 && s >= 0.12 && l >= 0.015 && l <= 0.97
}

const pct = (value) => `${+(value * 100).toFixed(1)}%`

/** La même couleur, exprimée depuis les deux variables de l'organisation. */
export function accentOf(color) {
  const rgba = parse(color)
  const { h, s, l } = toHsl(rgba)
  const alpha = rgba.a >= 1 ? '' : ` / ${+rgba.a.toFixed(3)}`
  return `hsl(calc(${Math.round(h * 360)}deg + var(--accent-shift, 0deg)) min(100%, calc(${pct(s)} * var(--accent-saturation, 1))) ${pct(l)}${alpha})`
}

/** Sélecteur limité à l'organisation qui a choisi une couleur, et au bon thème. */
function scope(selector, theme) {
  return selector
    .split(/,(?![^(]*\))/)
    .map((part) => {
      const item = part.trim()
      const light = ':root[data-theme="light"]'
      if (item.startsWith(light)) return item.replace(light, ':root[data-accent][data-theme="light"]')
      if (item.startsWith('html[data-theme="light"]')) return item.replace('html[data-theme="light"]', 'html[data-accent][data-theme="light"]')
      const prefix = `:root[data-accent][data-theme="${theme}"]`
      if (item.startsWith(':root')) return item.replace(':root', prefix)
      if (item.startsWith('html')) return item.replace(/^html/, `html[data-accent][data-theme="${theme}"]`)
      return `${prefix} ${item}`
    })
    .join(',\n')
}

/**
 * Famille d'une propriété : un raccourci et ses longhands se disputent la même
 * valeur (background / background-color, border / border-top-color…).
 */
function family(property) {
  if (/^background(-color|-image)?$/.test(property)) return 'background'
  if (/^border(-(top|right|bottom|left))?(-color)?$/.test(property)) return 'border'
  if (/^outline(-color)?$/.test(property)) return 'outline'
  return property
}

const declarationsOf = (rule) =>
  rule.body
    .split(';')
    .map((line) => line.trim())
    .filter((line) => line.includes(':'))
    .map((line) => ({ line, property: line.slice(0, line.indexOf(':')).trim(), value: line.slice(line.indexOf(':') + 1).trim() }))

/** Réécrite : au moins une couleur d'accent écrite en dur (une var() voisine reste telle quelle, résolue ailleurs). */
function converts({ value }) {
  if (!HAS_COLOR.test(value)) return false
  const found = value.match(COLOR) ?? []
  COLOR.lastIndex = 0
  return found.some(isAccent)
}

const blocks = new Map()
let count = 0
for (const [files, theme] of [[DARK, 'dark'], [LIGHT, 'light']]) {
  // Fins de ligne unifiées : les déclarations reprises telles quelles ne dépendent pas du poste.
  const parsed = files.flatMap((file) => rules(readFileSync(`${root}${file}`, 'utf8').replace(/\r\n/g, '\n')))
  // Familles réécrites quelque part : TOUTES leurs déclarations sont reprises, dans
  // l'ordre d'origine et avec le même sélecteur renforcé. Sinon une règle d'accent
  // passerait devant une règle plus tardive qui la remplaçait (« transparent »…).
  const touched = new Set(parsed.flatMap((rule) => declarationsOf(rule).filter(converts).map((item) => family(item.property))))
  for (const rule of parsed) {
    const declarations = declarationsOf(rule)
      .filter((item) => touched.has(family(item.property)))
      .map((item) => {
        if (!converts(item)) return `  ${item.line};`
        count++
        COLOR.lastIndex = 0
        const value = item.value.replace(COLOR, (color) => (isAccent(color) ? accentOf(color) : color))
        COLOR.lastIndex = 0
        return `  ${item.property}: ${value};`
      })
    if (!declarations.length) continue
    // Raccourci « background » repris : il remet background-clip à zéro. Un texte en
    // dégradé (background-clip: text) deviendrait un rectangle : on le réapplique.
    if (declarations.some((line) => /^\s*background:/.test(line))) {
      const clips = rule.body
        .split(';')
        .map((line) => line.trim())
        .filter((line) => /^(-webkit-)?background-clip\s*:|^-webkit-text-fill-color\s*:/.test(line))
      declarations.push(...clips.map((line) => `  ${line};`))
    }
    const key = rule.wrapper ?? ''
    blocks.set(key, [...(blocks.get(key) ?? []), `${scope(rule.selector, theme)} {\n${declarations.join('\n')}\n}`])
  }
}

const body = [...blocks.entries()].map(([wrapper, items]) => (wrapper ? `${wrapper} {\n${items.join('\n\n')}\n}` : items.join('\n\n'))).join('\n\n')
const output = `/* Couleur de l'interface GÉNÉRÉE par scripts/generate-accent-theme.mjs (${count} déclarations) : ne pas modifier à la main.\n   Active seulement sous :root[data-accent] (couleur choisie par l'organisation). */\n\n${body}\n`
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(`${root}theme-accent.css`, 'utf8')
  } catch {
    // Fichier absent : traité comme périmé.
  }
  if (current.replace(/\r\n/g, '\n') !== output) {
    console.error('theme-accent.css est périmé : lancez « npm run theme ».')
    process.exit(1)
  }
} else {
  writeFileSync(`${root}theme-accent.css`, output)
  console.log(`theme-accent.css : ${count} déclarations d'accent converties.`)
}
