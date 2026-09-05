import rrulePackage from 'rrule'
const { RRule } = rrulePackage

const formatters = new Map<string, Intl.DateTimeFormat>()
export function validateAutomationTimezone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0)
    return zone
  } catch { throw new Error('无效的 IANA 时区，例如 Asia/Shanghai') }
}

export function wallTime(ms: number, zone: string): number {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    if (formatters.size > 100) formatters.clear()
    formatters.set(zone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, part.value]))
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!)
}

// Return the first occurrence of a repeated wall time. Nonexistent DST times are skipped.
function fromWall(ms: number, zone: string): number | null {
  const offsets = new Set([-86400000, 0, 86400000].map((delta) => wallTime(ms + delta, zone) - (ms + delta)))
  const values = [...offsets].map((offset) => ms - offset).filter((value) => wallTime(value, zone) === ms)
  return values.length ? Math.min(...values) : null
}

export function createAutomationSchedule(text: string, timezone: string, anchor: number) {
  validateAutomationTimezone(timezone)
  const raw = text.trim().replace(/^RRULE:/u, '')
  const fields = raw.split(';')
  const allowed = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'WKST'])
  if (fields.some((field) => !allowed.has(field.split('=')[0] ?? '')) || new Set(fields.map((field) => field.split('=')[0])).size !== fields.length) {
    throw new Error('暂不支持此 RRULE 字段；支持 FREQ、INTERVAL、BYDAY、BYHOUR、BYMINUTE、WKST')
  }
  const options = RRule.parseString(raw)
  if (![RRule.MINUTELY, RRule.HOURLY, RRule.DAILY, RRule.WEEKLY].includes(options.freq!)) throw new Error('频率仅支持 MINUTELY、HOURLY、DAILY、WEEKLY')
  if (options.interval !== undefined && (!Number.isInteger(options.interval) || options.interval < 1 || options.interval > 10000)) throw new Error('INTERVAL 必须为 1–10000 的整数')
  for (const [name, max] of [['BYHOUR', 23], ['BYMINUTE', 59]] as const) {
    const field = fields.find((entry) => entry.startsWith(`${name}=`))
    if (field && !field.slice(name.length + 1).split(',').every((entry) => /^\d+$/u.test(entry) && +entry <= max)) throw new Error(`${name} 超出有效范围`)
  }
  const byday = fields.find((field) => field.startsWith('BYDAY='))
  if (byday && !byday.slice(6).split(',').every((day) => /^(MO|TU|WE|TH|FR|SA|SU)$/u.test(day))) throw new Error('BYDAY 仅支持 MO–SU')
  const start = Math.floor(anchor / 60000) * 60000
  const interval = options.interval ?? 1
  if (options.freq === RRule.MINUTELY || options.freq === RRule.HOURLY) {
    if (fields.some((field) => /^(BY|WKST)/u.test(field))) throw new Error('分钟/小时规则目前仅支持 INTERVAL；指定日历时点请使用 DAILY/WEEKLY')
    const step = interval * (options.freq === RRule.MINUTELY ? 60000 : 3600000)
    return {
      next: (after: number): number => start + Math.max(0, Math.floor((after - start) / step) + 1) * step,
      previous: (before: number): number | null => before < start ? null : start + Math.floor((before - start) / step) * step,
    }
  }
  const rule = new RRule({ ...options, dtstart: new Date(wallTime(start, timezone)), bysecond: [0] })
  function occurrence(at: number, direction: 'next' | 'previous'): number | null {
    let cursor = new Date(wallTime(at, timezone))
    for (let count = 0; count < 10; count++) {
      const candidate = direction === 'next' ? rule.after(cursor, false) : rule.before(cursor, count === 0)
      if (!candidate) return null
      const actual = fromWall(candidate.getTime(), timezone)
      if (actual !== null && (direction === 'next' ? actual > at : actual <= at)) return actual
      cursor = candidate
    }
    throw new Error('无法计算有效的下次执行时间，请检查规则与时区')
  }
  return { next: (after: number) => occurrence(after, 'next'), previous: (before: number) => occurrence(before, 'previous') }
}
