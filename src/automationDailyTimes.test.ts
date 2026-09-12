import { describe, expect, it } from 'vitest'
import { buildDailyTimesRule, readDailyTimesRule, normalizeDailyTimes } from './automationDailyTimes'
import { createAutomationSchedule } from './server/automationSchedule'
import { parseAutomationToml, serializeAutomationToml } from './server/automationDefinition'

describe('daily automation times', () => {
  it('roundtrips selected pairs without creating a cartesian product', () => {
    const rule = buildDailyTimesRule(['18:45', '08:15', '08:15'])
    expect(readDailyTimesRule(rule)).toEqual(['08:15', '18:45'])
    const schedule = createAutomationSchedule(rule, 'Asia/Shanghai', Date.parse('2026-09-01T00:00:00Z'))
    const first = schedule.next(Date.parse('2026-09-12T00:00:00Z'))!
    expect(new Date(first).toISOString()).toBe('2026-09-12T00:15:00.000Z')
    const second = schedule.next(first)!
    expect(new Date(second).toISOString()).toBe('2026-09-12T10:45:00.000Z')
    expect(new Date(schedule.next(second)!).toISOString()).toBe('2026-09-13T00:15:00.000Z')
    expect(schedule.previous(second)).toBe(second)
    expect(schedule.previous(second - 1)).toBe(first)
  })
  it('preserves old daily rules and their explicit cartesian meaning', () => {
    expect(readDailyTimesRule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')).toEqual(['09:00'])
    expect(buildDailyTimesRule(['09:00'])).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
    expect(readDailyTimesRule('FREQ=DAILY;BYHOUR=8,18;BYMINUTE=15,45')).toEqual(['08:15','08:45','18:15','18:45'])
    expect(readDailyTimesRule('FREQ=DAILY;BYDAY=MO;BYHOUR=9;BYMINUTE=0')).toBeNull()
    expect(readDailyTimesRule('FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0')).toBeNull()
  })
  it('bounds rules and rejects empty or invalid lists', () => {
    expect(() => normalizeDailyTimes([])).toThrow()
    expect(() => normalizeDailyTimes(['24:00'])).toThrow()
    expect(() => normalizeDailyTimes(Array(25).fill('08:00'))).toThrow()
    expect(() => createAutomationSchedule(Array(25).fill('RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0').join('\n'),'UTC',0)).toThrow()
  })
  it('preserves selected pairs through TOML serialization', () => {
    const original = parseAutomationToml("id='test'\nname='test'\nprompt='test'\nrrule='FREQ=DAILY;BYHOUR=8;BYMINUTE=15'\n")!
    const rule = buildDailyTimesRule(['08:15','18:45'])
    const restored = parseAutomationToml(serializeAutomationToml({...original,rrule:rule}))!
    expect(restored.rrule).toBe(rule)
    expect(readDailyTimesRule(restored.rrule)).toEqual(['08:15','18:45'])
  })
  it('keeps DST skip and repeat semantics for multiple times', () => {
    const spring = createAutomationSchedule(buildDailyTimesRule(['02:30','08:15']), 'America/New_York', Date.parse('2026-03-01T00:00:00Z'))
    expect(new Date(spring.next(Date.parse('2026-03-08T05:00:00Z'))!).toISOString()).toBe('2026-03-08T12:15:00.000Z')
    const fall = createAutomationSchedule(buildDailyTimesRule(['01:30','08:15']), 'America/New_York', Date.parse('2026-10-01T00:00:00Z'))
    const first = fall.next(Date.parse('2026-11-01T04:00:00Z'))!
    expect(new Date(first).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    expect(new Date(fall.next(first)!).toISOString()).toBe('2026-11-01T13:15:00.000Z')
  })
  it('supports the bounded 24-time list across a full day', () => {
    const times = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:15`)
    const start = performance.now()
    const schedule = createAutomationSchedule(buildDailyTimesRule(times), 'Asia/Shanghai', Date.parse('2026-09-01T00:00:00Z'))
    let cursor = Date.parse('2026-09-11T16:00:00Z')
    for (let hour = 0; hour < 24; hour++) {
      cursor = schedule.next(cursor)!
      expect(cursor).toBe(Date.parse('2026-09-11T16:15:00Z') + hour * 3600000)
    }
    console.info(`24-time schedule: 24 next calculations in ${(performance.now() - start).toFixed(1)}ms`)
  })

})
