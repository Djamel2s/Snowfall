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
import { COLOR, format, fromHsl, HAS_COLOR, parse, rules, toHsl } from './css-tools.mjs'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const SOURCES = ['index.css', 'App.css', 'workspace.css', 'agents.css', 'markdown.css']
const SHADOWS = new Set(['box-shadow', 'text-shadow', 'filter', 'drop-shadow'])

export function lighten(color, property) {
  const rgba = parse(color)
  const hsl = toHsl(rgba)
  // Ombres : restent sombres, un peu plus légères sur fond clair.
  if (SHADOWS.has(property) && hsl.l < 0.35) return format({ ...rgba, a: rgba.a * 0.45 })
  // Voile clair coloré et transparent (sélection, survol, carte teintée) : sur fond clair, il
  // reste un voile de la même teinte, pas un gris sombre. L'inverser comme un texte
  // clair donnait des états « sélectionné » gris au lieu de bleu ciel.
  if (rgba.a < 0.5 && hsl.s > 0.25 && hsl.l > 0.5 && !SHADOWS.has(property)) {
    return format({ ...fromHsl({ h: hsl.h, s: Math.max(hsl.s, 0.6), l: 0.5 }), a: rgba.a })
  }
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
    // Raccourci « background » converti : il remet background-clip à zéro. Un texte en
    // dégradé (titre d'accueil, logo) deviendrait un rectangle : on réapplique le découpage.
    if (declarations.some((line) => /^\s*background:/.test(line))) {
      const clips = rule.body
        .split(';')
        .map((line) => line.trim())
        .filter((line) => /^(-webkit-)?background-clip\s*:|^-webkit-text-fill-color\s*:/.test(line))
      declarations.push(...clips.map((line) => `  ${line};`))
    }
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
