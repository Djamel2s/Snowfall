// Logo de l'organisation : seulement du PNG ou du JPEG, reconnu par son contenu
// (jamais par son nom ou son type annoncé), de taille et de dimensions bornées.
// Pas de SVG : une image vectorielle peut porter du script.

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_SIDE = 1024;
export const LOGO_MIN_SIDE = 16;

export type LogoImage = { type: "image/png" | "image/jpeg"; width: number; height: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(bytes: Buffer): LogoImage | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  // Premier bloc obligatoire : IHDR (largeur, hauteur sur 4 octets chacune).
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { type: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpeg(bytes: Buffer): LogoImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0 à SOF15 (sauf DHT, JPG, DAC) : hauteur puis largeur.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { type: "image/jpeg", width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** Image acceptée comme logo, ou la raison du refus. */
export function inspectLogo(bytes: Buffer): LogoImage | "too_large" | "unsupported" | "dimensions" {
  if (bytes.length > LOGO_MAX_BYTES) return "too_large";
  const image = png(bytes) ?? jpeg(bytes);
  if (!image) return "unsupported";
  const sides = [image.width, image.height];
  if (sides.some((side) => side < LOGO_MIN_SIDE || side > LOGO_MAX_SIDE)) return "dimensions";
  return image;
}
