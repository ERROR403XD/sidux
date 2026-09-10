import { effectScope } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useTransientNotice } from './useTransientNotice'

afterEach(() => vi.useRealTimers())
it('expires success feedback and renews repeated actions without leaking timers', () => {
  vi.useFakeTimers()
  const scope = effectScope()
  const notice = scope.run(() => useTransientNotice())!
  notice.value = '已保存'
  vi.advanceTimersByTime(3000)
  notice.value = '已保存'
  vi.advanceTimersByTime(1000)
  expect(notice.value).toBe('已保存')
  expect(vi.getTimerCount()).toBe(1)
  vi.advanceTimersByTime(2500)
  expect(notice.value).toBe('')
  notice.value = '通知已发送'
  notice.value = ''
  expect(vi.getTimerCount()).toBe(0)
  notice.value = '账号已切换'
  scope.stop()
  expect(vi.getTimerCount()).toBe(0)
})
