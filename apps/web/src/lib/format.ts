import { formatNumber, getLocale } from './i18n'

const UNITS = { fr: ['o', 'Ko', 'Mo'], en: ['B', 'KB', 'MB'] } as const

export function formatSize(bytes: number) {
  const [byte, kilo, mega] = UNITS[getLocale()]
  if (bytes < 1024) return `${bytes} ${byte}`
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 1024))} ${kilo}`
  return `${formatNumber(Math.round((bytes / 1024 / 1024) * 10) / 10)} ${mega}`
}
