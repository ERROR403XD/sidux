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
  const time = formatLocalDateTime(at, { year: undefined, month: undefined, day: undefined, hour: '2-digit', minute: '2-digit' }, 'zh-CN')
  let day = formatLocalDateTime(at, { year: undefined, month: undefined, day: undefined, hour: undefined, minute: undefined, weekday: 'short' }, 'zh-CN')
  if (minutes === 300) {
    const dateOptions: Intl.DateTimeFormatOptions = { hour: undefined, minute: undefined }
    const targetDate = formatLocalDateTime(at, dateOptions, 'sv-SE')
    const today = formatLocalDateTime(now, dateOptions, 'sv-SE')
    // Advance a calendar date, not 24 hours in the selected timezone (DST days vary).
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    if (targetDate === today) day = '今天'
    else if (targetDate === tomorrow) day = '明天'
  }
  return `${day} ${time}`
}
