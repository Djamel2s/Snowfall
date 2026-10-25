// Scripts d'une compétence : Python seulement (le bac à sable n'exécute que lui).
// Gardés comme texte (chiffré comme tout fichier de compétence), exécutés à la
// demande dans le bac à sable, jamais sur l'API.

export const SKILL_SCRIPT_TYPE = "text/x-python";
export const SKILL_SCRIPT_MAX_BYTES = 200 * 1024;

export const isPythonScript = (name: string) => /\.py$/i.test(name);

/** Autres langages : mis de côté à l'import (aucun moyen de les exécuter ici). */
export const isOtherScript = (name: string) => /\.(js|mjs|cjs|ts|sh|bash|zsh|rb|ps1|bat|cmd|exe|jar)$/i.test(name);

/** Texte d'un script : UTF-8 valide, sans octet nul, taille bornée ; sinon null. */
export function scriptText(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > SKILL_SCRIPT_MAX_BYTES || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** Fichiers texte copiés à côté du script (une référence PDF n'est gardée que par son texte extrait : inutile à un script). */
const COPIED_TYPES = new Set([SKILL_SCRIPT_TYPE, "text/plain", "text/markdown", "text/csv", "application/json"]);
export const copiedToSandbox = (mediaType: string) => COPIED_TYPES.has(mediaType);

/**
 * Chemin accepté par le bac à sable : segments [A-Za-z0-9_.-], 5 niveaux au plus,
 * ni « . », « .. », ni fichier caché. Les autres caractères deviennent « _ ».
 */
export function sandboxPath(name: string): string | null {
  const parts = name
    .split("/")
    .filter(Boolean)
    .map((part) => part.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80));
  if (!parts.length || parts.length > 5 || parts.some((part) => part === "." || part === ".." || part.startsWith("."))) return null;
  return parts.join("/");
}
