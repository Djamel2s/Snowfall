import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { MessageBranch } from '../lib/api'
import { useI18n } from '../lib/i18n'

/** ‹ 2/3 › : passer d'une version à l'autre d'un message (modification, régénération). */
export default function BranchSwitcher({ branch, disabled, onSelect }: { branch: MessageBranch; disabled: boolean; onSelect: (messageId: string) => void }) {
  const { t } = useI18n()
  const go = (offset: number) => {
    const target = branch.siblings[branch.index + offset]
    if (target) onSelect(target)
  }
  return (
    <span className="branch-switcher" role="group" aria-label={t('chat.versions')}>
      <button type="button" aria-label={t('chat.previousVersion')} title={t('chat.previousVersion')} disabled={disabled || branch.index === 0} onClick={() => go(-1)}>
        <ChevronLeft size={13} />
      </button>
      <span aria-live="polite">
        {branch.index + 1}/{branch.count}
      </span>
      <button type="button" aria-label={t('chat.nextVersion')} title={t('chat.nextVersion')} disabled={disabled || branch.index >= branch.count - 1} onClick={() => go(1)}>
        <ChevronRight size={13} />
      </button>
    </span>
  )
}
