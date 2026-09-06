export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const formatters = new Map<string, Intl.DateTimeFormat>()

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE
  } catch {
    return DEFAULT_TIME_ZONE
  }
}

export function formatLocalDateTime(value: string | number, options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const settings: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...options, timeZone: browserTimeZone(),
  }
  const key = JSON.stringify([locale, settings])
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, settings)
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!)
    formatters.set(key, formatter)
  }
  return formatter.format(date)
}
