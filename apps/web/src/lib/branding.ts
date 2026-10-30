import { useSyncExternalStore } from 'react'
import { api } from './api'

// Identité de l'organisation, partout où apparaît le logo (fond, barre,
// avatars, onglet du navigateur) : son logo importé, sinon celui de Snowfall,
// recoloré dans la couleur choisie. Un seul état, lu par useBranding().

export const DEFAULT_LOGO = '/logo.png'
/** Teinte dominante du logo de Snowfall (mesurée sur l'image : bleu, 204°, saturation 1). */
const DEFAULT_HUE = 204

export type BrandingState = { name: string | null; color: string | null; logoVersion: number | null; logo: string }

let state: BrandingState = { name: null, color: null, logoVersion: null, logo: DEFAULT_LOGO }
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null

function publish(next: BrandingState) {
  state = next
  listeners.forEach((listener) => listener())
  setFavicon(next.logo)
  applyAccent(next.color)
}

/** Teinte de référence des accents de l'interface (scripts/generate-accent-theme.mjs). */
const ACCENT_REFERENCE_HUE = 210
/** Saturation typique des accents d'origine : le facteur se calcule depuis elle. */
const ACCENT_REFERENCE_SATURATION = 0.85

/**
 * Couleur de l'interface : deux variables sur <html> (décalage de teinte,
 * facteur de saturation) lues par theme-accent.css. La luminosité de chaque
 * couleur reste celle d'origine : le contraste des textes ne change pas.
 * Sans couleur : aucun attribut, l'interface d'origine.
 */
export function applyAccent(color: string | null) {
  const element = document.documentElement
  const hsl = color ? hslOf(color) : null
  if (!hsl) {
    delete element.dataset.accent
    element.style.removeProperty('--accent-shift')
    element.style.removeProperty('--accent-saturation')
    element.style.removeProperty('--logo-blue')
    return
  }
  const shift = hsl.hue === null ? 0 : hsl.hue - ACCENT_REFERENCE_HUE
  const saturation = Math.min(1.2, Math.max(0.12, hsl.saturation / ACCENT_REFERENCE_SATURATION))
  element.dataset.accent = ''
  element.style.setProperty('--accent-shift', `${shift.toFixed(1)}deg`)
  element.style.setProperty('--accent-saturation', saturation.toFixed(3))
  // Accent des réponses du modèle (bleu du logo, 204°, 100 %, 50 %), même transformation.
  element.style.setProperty('--logo-blue', `hsl(${(204 + shift).toFixed(1)}deg ${Math.min(100, 100 * saturation).toFixed(1)}% 50%)`)
}

function setFavicon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link && link.href !== href) link.href = href
}

/** Teinte (0–360, null pour un gris pur) et saturation (0–1) d'une couleur #rrggbb. */
function hslOf(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const light = (max + min) / 2
  if (delta === 0) return { hue: null, saturation: 0 }
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { hue: (hue * 60 + 360) % 360, saturation: delta / (1 - Math.abs(2 * light - 1)) }
}

/**
 * Logo de Snowfall dans une autre couleur : chaque pixel garde sa luminosité
 * (dégradés, ombres, reflets) ; sa teinte tourne de l'écart entre le bleu
 * d'origine et la couleur choisie, et sa saturation suit celle de la couleur
 * (un gris donne un logo gris, dans les mêmes nuances). Blancs et gris restent tels quels.
 */
export async function recolorLogo(hex: string, source = DEFAULT_LOGO): Promise<string> {
  const { hue: targetHue, saturation: targetSaturation } = hslOf(hex)
  const target = targetHue ?? DEFAULT_HUE
  const image = new Image()
  image.src = source
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) return source
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const data = pixels.data
  const shift = target - DEFAULT_HUE
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue
    const r = data[index]! / 255
    const g = data[index + 1]! / 255
    const b = data[index + 2]! / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    if (delta < 0.04) continue
    const light = (max + min) / 2
    const saturation = Math.min(1, (delta / (1 - Math.abs(2 * light - 1))) * targetSaturation)
    let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
    hue = ((hue * 60 + shift) % 360 + 360) % 360
    // HSL → RGB, même saturation et même luminosité.
    const chroma = (1 - Math.abs(2 * light - 1)) * saturation
    const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
    const m = light - chroma / 2
    const [rr, gg, bb] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x]
    data[index] = Math.round((rr + m) * 255)
    data[index + 1] = Math.round((gg + m) * 255)
    data[index + 2] = Math.round((bb + m) * 255)
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

/** Logo affiché : celui de l'organisation (adresse versionnée), sinon Snowfall recoloré. */
async function resolve(color: string | null, logoVersion: number | null) {
  if (logoVersion !== null) return `/api/branding/logo?v=${logoVersion}`
  return color ? recolorLogo(color).catch(() => DEFAULT_LOGO) : DEFAULT_LOGO
}

/** Relit l'identité (au démarrage, après un changement dans Administration). */
export function refreshBranding() {
  loading = api
    .getBranding()
    .then(async (branding) => {
      const logoVersion = branding.logo?.version ?? null
      publish({ name: branding.name, color: branding.color, logoVersion, logo: await resolve(branding.color, logoVersion) })
    })
    .catch(() => undefined)
  return loading
}

export function useBranding(): BrandingState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      if (!loading) void refreshBranding()
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

/**
 * Image prête à l'envoi : redimensionnée dans le navigateur (512 px au plus sur
 * le grand côté, proportions gardées), en PNG ; en JPEG si le PNG reste trop lourd.
 */
export async function prepareLogo(file: File, maxSide = 512, maxBytes = 500 * 1024): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(16, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(16, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas')
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = (type: string, quality?: number) => new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality))
    const png = await blob('image/png')
    if (png && png.size <= maxBytes) return png
    const jpeg = await blob('image/jpeg', 0.9)
    if (jpeg && jpeg.size <= maxBytes) return jpeg
    throw new Error('too_large')
  } finally {
    URL.revokeObjectURL(url)
  }
}
