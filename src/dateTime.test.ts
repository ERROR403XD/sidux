import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserTimeZone, DEFAULT_TIME_ZONE, formatLocalDateTime } from './dateTime'

afterEach(() => vi.restoreAllMocks())

describe('local time presentation', () => {
  it.each([
    ['Asia/Shanghai', '01:00', '2026-09-07'],
    ['America/New_York', '13:00', '2026-09-06'],
  ])('uses browser timezone %s across date boundaries', (timeZone, time, date) => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions)
    const shown = formatLocalDateTime('2026-09-06T17:00:00Z', {}, 'sv-SE')
    expect(shown).toContain(time)
    expect(shown).toContain(date)
  })

  it('falls back to Shanghai when browser timezone cannot be read', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => { throw new Error('unavailable') })
    expect(browserTimeZone()).toBe(DEFAULT_TIME_ZONE)
    expect(formatLocalDateTime('2026-09-06T17:00:00Z', {}, 'sv-SE')).toContain('2026-09-07 01:00')
    expect(formatLocalDateTime('invalid')).toBe('—')
  })
})
