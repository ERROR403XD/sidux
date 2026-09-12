export const MAX_DAILY_TIMES = 24

export function normalizeDailyTimes(times: string[]): string[] {
  if (!times.length || times.length > MAX_DAILY_TIMES || times.some(time => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new Error('请选择 1–24 个有效时间（HH:mm）')
  }
  return [...new Set(times)].sort()
}

export function buildDailyTimesRule(times: string[]): string {
  const rules = normalizeDailyTimes(times).map(time => {
    const [hour, minute] = time.split(':').map(Number)
    return `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`
  })
  return rules.length === 1 ? rules[0]! : rules.map(rule => `RRULE:${rule}`).join('\n')
}

// Only convert rules that the daily editor can represent without losing constraints.
export function readDailyTimesRule(text: string): string[] | null {
  const lines = text.trim().split(/\r?\n/).filter(Boolean)
  if (!lines.length || lines.length > MAX_DAILY_TIMES) return null
  const times = new Set<string>()
  for (const line of lines) {
    const fields = line.trim().replace(/^RRULE:/, '').split(';')
    const parts: Record<string, string> = {}
    for (const field of fields) {
      const match = /^(FREQ|INTERVAL|BYHOUR|BYMINUTE)=([^=]+)$/.exec(field)
      if (!match || parts[match[1]!] !== undefined) return null
      parts[match[1]!] = match[2]!
    }
    if (parts.FREQ !== 'DAILY' || (parts.INTERVAL !== undefined && parts.INTERVAL !== '1')) return null
    const hours = parts.BYHOUR?.split(',')
    const minutes = parts.BYMINUTE?.split(',')
    if (!hours?.length || !minutes?.length || hours.length * minutes.length > MAX_DAILY_TIMES) return null
    if (hours.some(value => !/^\d{1,2}$/.test(value) || +value > 23) || minutes.some(value => !/^\d{1,2}$/.test(value) || +value > 59)) return null
    for (const hour of hours) for (const minute of minutes) times.add(`${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`)
    if (times.size > MAX_DAILY_TIMES) return null
  }
  return [...times].sort()
}
