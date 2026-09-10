import { t, useUiLanguage } from './composables/useUiLanguage'
import { formatLocalDateTime } from './dateTime'

export function quotaRemaining(used: number): number {
  return Math.round(100 - Math.max(0, Math.min(100, Number.isFinite(used) ? used : 0)))
}

export function quotaColor(used: number): string {
  const colors = ['#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444']
  return colors[Math.min(4, Math.max(0, Math.floor((Number.isFinite(used) ? used : 0) / 20)))]!
}

export function quotaResetTime(seconds: number, minutes: number | null, now = Date.now()): string {
  const at = seconds * 1000
  if (!Number.isFinite(at)) return '—'
  const time = formatLocalDateTime(at, { year: undefined, month: undefined, day: undefined, hour: '2-digit', minute: '2-digit' }, useUiLanguage().uiLanguage.value)
  const dateOptions: Intl.DateTimeFormatOptions = { hour: undefined, minute: undefined }
  const targetDate = formatLocalDateTime(at, dateOptions, 'sv-SE')
  const today = formatLocalDateTime(now, dateOptions, 'sv-SE')
  const days = Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  const day = days >= 0 && days <= 2 ? t(['今天', '明天', '后天'][days]!)
    : days >= 0 && days <= 7 ? formatLocalDateTime(at, { year: undefined, month: undefined, day: undefined, hour: undefined, minute: undefined, weekday: 'short' }, useUiLanguage().uiLanguage.value)
    : targetDate.slice(5).replace('-', '/')
  return `${day} ${time}`
}
