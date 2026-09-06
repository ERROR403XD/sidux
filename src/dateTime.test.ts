import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, watchEffect } from 'vue'
import { browserTimeZone, DEFAULT_TIME_ZONE, DISPLAY_TIME_ZONE_STORAGE_KEY, displayTimeZonePreference, formatLocalDateTime, setDisplayTimeZone, subscribeDisplayTimeZoneStorage } from './dateTime'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setDisplayTimeZone('system')
})

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

  it('updates existing reactive dates immediately without changing the browser/execution timezone', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Asia/Shanghai' } as Intl.ResolvedDateTimeFormatOptions)
    let shown = ''
    const stop = watchEffect(() => { shown = formatLocalDateTime('2026-09-06T17:00:00Z', {}, 'sv-SE') })
    expect(shown).toContain('2026-09-07 01:00')
    setDisplayTimeZone('America/New_York')
    await nextTick()
    expect(shown).toContain('2026-09-06 13:00')
    expect(browserTimeZone()).toBe('Asia/Shanghai')
    setDisplayTimeZone('UTC')
    await nextTick()
    expect(shown).toContain('2026-09-06 17:00')
    setDisplayTimeZone('system')
    await nextTick()
    expect(shown).toContain('2026-09-07 01:00')
    stop()
  })

  it('uses IANA daylight-saving rules and rejects invalid choices', () => {
    setDisplayTimeZone('America/New_York')
    expect(formatLocalDateTime('2026-03-08T06:30:00Z', {}, 'sv-SE')).toContain('01:30')
    expect(formatLocalDateTime('2026-03-08T07:30:00Z', {}, 'sv-SE')).toContain('03:30')
    expect(() => setDisplayTimeZone('Invalid/Zone')).toThrow('有效')
    expect(displayTimeZonePreference.value).toBe('America/New_York')
  })

  it('verifies storage before applying a preference and exposes failed writes', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => data.set(key, value) } })
    setDisplayTimeZone('UTC')
    expect(data.get(DISPLAY_TIME_ZONE_STORAGE_KEY)).toBe('UTC')
    window.localStorage.setItem = () => { throw new Error('quota exceeded') }
    expect(() => setDisplayTimeZone('Asia/Shanghai')).toThrow('无法保存')
    expect(displayTimeZonePreference.value).toBe('UTC')
    window.localStorage.setItem = () => {}
    expect(() => setDisplayTimeZone('Asia/Shanghai')).toThrow('无法保存')
    expect(displayTimeZonePreference.value).toBe('UTC')
  })

  it('syncs other tabs, handles cleared or invalid storage, and removes its listener', () => {
    let value = 'America/New_York'
    let listener: (event: { key: string | null }) => void = () => {}
    const remove = vi.fn()
    vi.stubGlobal('window', { localStorage: { getItem: () => value }, addEventListener: (_: string, callback: typeof listener) => { listener = callback }, removeEventListener: remove })
    const unsubscribe = subscribeDisplayTimeZoneStorage()
    listener({ key: 'unrelated' })
    expect(displayTimeZonePreference.value).toBe('system')
    listener({ key: DISPLAY_TIME_ZONE_STORAGE_KEY })
    expect(displayTimeZonePreference.value).toBe('America/New_York')
    value = 'Invalid/Zone'
    listener({ key: DISPLAY_TIME_ZONE_STORAGE_KEY })
    expect(displayTimeZonePreference.value).toBe('system')
    value = 'UTC'
    listener({ key: null })
    expect(displayTimeZonePreference.value).toBe('UTC')
    unsubscribe()
    expect(remove).toHaveBeenCalledWith('storage', listener)
  })
})
