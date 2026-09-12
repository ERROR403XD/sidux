import { computed } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { setUiLanguage, t } from './useUiLanguage'

afterEach(() => { setUiLanguage('en'); vi.unstubAllGlobals() })

it('updates existing UI labels and parameterized messages when language changes', () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: { setItem: (key: string, value: string) => storage.set(key, value) } })
  vi.stubGlobal('document', { documentElement: { lang: '', dataset: {} }, dispatchEvent: vi.fn() })
  const label = computed(() => t('Current branch'))
  setUiLanguage('en')
  expect(label.value).toBe('Current branch')
  setUiLanguage('zh-CN')
  expect(label.value).toBe('当前分支')
  expect(t('Project directory: {path}', { path: '/tmp/原始 path' })).toBe('项目目录：/tmp/原始 path')
  expect(t('RRULE: {rrule} · runs every {count} hours', { rrule: 'FREQ=HOURLY', count: 2 })).toBe('RRULE: FREQ=HOURLY · 每 2 小时运行')
  expect(storage.get('codex-web-local.ui-language.v1')).toBe('zh-CN')
  for (const command of ['Commit', 'Pull', 'Push', 'Fetch', 'Reset', 'Rebase', 'Merge', 'Checkout']) expect(t(command)).toBe(command)
  expect(t('Worktree')).toBe('工作树')
  expect(t('raw external error /home/Code')).toBe('raw external error /home/Code')
  setUiLanguage('en')
  expect(label.value).toBe('Current branch')
})
