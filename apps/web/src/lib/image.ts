const SIZE = 256
// Marge sous la limite serveur (150 Ko d'image décodée).
const MAX_DATA_URL_LENGTH = 190_000

/**
 * Recadre au carré, réduit à 256 px et réencode en WebP dans le navigateur :
 * la photo d'origine (et ses métadonnées EXIF, GPS…) n'est jamais envoyée.
 */
export async function toAvatarDataUrl(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Format accepté : PNG, JPEG ou WebP.')
  }

  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE

  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image illisible.')

  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  )
  bitmap.close()

  // Safari n'encode pas toujours le WebP : repli sur JPEG.
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const quality of [0.86, 0.75, 0.6, 0.45]) {
      const data = canvas.toDataURL(type, quality)
      if (data.startsWith(`data:${type}`) && data.length <= MAX_DATA_URL_LENGTH) return data
    }
  }
  throw new Error('Image trop lourde.')
}
