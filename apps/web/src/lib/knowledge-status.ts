// État d'un document de la base : code d'échec renvoyé par l'API → libellé court.

export type FailureKey =
  | 'knowledge.failed.link'
  | 'knowledge.failed.blocked'
  | 'knowledge.failed.unreadable'
  | 'knowledge.failed.empty'
  | 'knowledge.failed.ocr'
  | 'knowledge.failed.embedding'
  | 'knowledge.failed.quota'
  | 'knowledge.failed.format'
  | 'knowledge.failed.full'
  | 'knowledge.failed.generic'
  | 'knowledge.failed.malware'

/** Code d'échec renvoyé par l'API → libellé court. */
export function failureKey(code: string | null): FailureKey {
  if (!code) return 'knowledge.failed.generic'
  if (code === 'malware') return 'knowledge.failed.malware'
  if (code === 'link_proxy_denied') return 'knowledge.failed.blocked'
  if (code === 'link_blocked_address' || code === 'link_domain_not_allowed') return 'knowledge.failed.blocked'
  if (code.startsWith('link_') || code === 'links_disabled') return 'knowledge.failed.link'
  if (code === 'unreadable' || code === 'extraction_timeout') return 'knowledge.failed.unreadable'
  if (code === 'empty') return 'knowledge.failed.empty'
  if (code === 'ocr_failed') return 'knowledge.failed.ocr'
  if (code === 'embedding_failed' || code === 'provider_not_allowed') return 'knowledge.failed.embedding'
  if (code === 'quota_exceeded') return 'knowledge.failed.quota'
  if (['audio_video', 'image', 'unsupported', 'too_large'].includes(code)) return 'knowledge.failed.format'
  if (code === 'too_many_chunks' || code === 'too_many_sources') return 'knowledge.failed.full'
  return 'knowledge.failed.generic'
}
