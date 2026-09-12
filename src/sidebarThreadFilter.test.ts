import { describe, expect, it } from 'vitest'
import { isFinalQuotaInterruption, matchesSidebarThreadFilter } from './sidebarThreadFilter'
import type { UiThread } from './types/codex'

const row = (id: string, unread = false, inProgress = false) => ({ id, unread, inProgress } as UiThread)
describe('sidebar status masks', () => {
  it('uses the existing live and blue-dot flags without reclassifying content', () => {
    expect(matchesSidebarThreadFilter(row('a', true), 'unread', '', {})).toBe(true)
    expect(matchesSidebarThreadFilter(row('b'), 'unread', '', {})).toBe(false)
    expect(matchesSidebarThreadFilter(row('a', false, true), 'active', '', {})).toBe(true)
    expect(matchesSidebarThreadFilter(row('a'), 'active', '', {})).toBe(false)
  })
  it('keeps only the selected just-read conversation and suppresses running quota matches', () => {
    expect(matchesSidebarThreadFilter(row('a'), 'unread', 'a', {})).toBe(true)
    expect(matchesSidebarThreadFilter(row('a'), 'unread', 'b', {})).toBe(false)
    expect(matchesSidebarThreadFilter(row('a', false, true), 'interrupted', '', { a: true })).toBe(false)
    expect(matchesSidebarThreadFilter(row('a'), 'interrupted', '', { a: null })).toBe(false)
  })
  it('only recognizes terminal quota errors, not recovered retries or ordinary interruptions', () => {
    expect(isFinalQuotaInterruption({ status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } })).toBe(true)
    expect(isFinalQuotaInterruption({ status: 'interrupted', error: { message: '额度不足' } })).toBe(true)
    for (const status of ['inProgress', 'completed']) expect(isFinalQuotaInterruption({ status, error: { message: 'quota exceeded' } })).toBe(false)
    expect(isFinalQuotaInterruption({ status: 'interrupted', error: null })).toBe(false)
    expect(isFinalQuotaInterruption({ status: 'failed', error: { message: '401 unauthorized' } })).toBe(false)
  })
})


it.each(['active', 'unread', 'interrupted'] as const)('keeps the retained row in %s without changing its actual status', filter => {
  const thread = row('a')
  expect(matchesSidebarThreadFilter(thread, filter, 'a', { a: false })).toBe(true)
  expect(matchesSidebarThreadFilter(thread, filter, 'b', { a: false })).toBe(false)
  expect(thread.inProgress).toBe(false)
  expect(thread.unread).toBe(false)
})
