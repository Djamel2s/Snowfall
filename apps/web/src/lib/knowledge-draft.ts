import type { api, KnowledgeOwnerKind } from './api'

type KnowledgeClient = Pick<typeof api, 'setKnowledgeConfidential' | 'addKnowledgeFile' | 'addKnowledgeLink'>

/** Document mis en attente pendant la création d'un agent (rien n'est encore envoyé). */
export type KnowledgeDraftItem =
  | { id: string; kind: 'file'; name: string; file: File }
  | { id: string; kind: 'link'; name: string; url: string }

export type KnowledgeDraft = { items: KnowledgeDraftItem[]; confidential: boolean }

export const emptyKnowledgeDraft: KnowledgeDraft = { items: [], confidential: false }

/**
 * Premier filtre sur un lien (http/https, sans identifiants), pour prévenir tout
 * de suite d'une faute de frappe. Le serveur refait toutes les vérifications (SSRF).
 */
export function draftLink(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Envoie les documents en attente dans la base qui vient d'être créée.
 * Le mode confidentiel est appliqué AVANT tout envoi : sinon le premier fichier
 * serait indexé avec les embeddings externes de l'organisation. S'il échoue,
 * rien n'est envoyé. Renvoie les échecs (vide si tout est passé).
 */
export async function submitKnowledgeDraft(
  api: KnowledgeClient,
  kind: KnowledgeOwnerKind,
  id: string,
  draft: KnowledgeDraft,
  fallback: string,
) {
  const reason = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : fallback)
  if (draft.confidential) {
    try {
      await api.setKnowledgeConfidential(kind, id, true)
    } catch (cause) {
      return [reason(cause)]
    }
  }
  const failures: string[] = []
  // Un par un : l'API limite le débit des imports, et l'ordre reste celui de l'utilisateur.
  for (const item of draft.items) {
    try {
      if (item.kind === 'file') await api.addKnowledgeFile(kind, id, item.file, item.name)
      else await api.addKnowledgeLink(kind, id, item.url)
    } catch (cause) {
      failures.push(`${item.name} : ${reason(cause)}`)
    }
  }
  return failures
}
