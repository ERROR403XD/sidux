import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./useUiLanguage', () => ({ useUiLanguage: () => ({ t: (text: string) => text }) }))

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each([
  ['auto', 'auto'], ['zh', 'zh'], ['en', 'en'], ['ZH-cn', 'zh'],
  ['invalid', 'auto'], ['', 'auto'], [null, 'auto'], ['constructor', 'auto'],
])('restores persisted dictation language %s on first use', async (stored, expected) => {
  vi.resetModules()
  const getItem = vi.fn((key: string) => key.endsWith('dictation-language.v1') ? stored : null)
  vi.stubGlobal('window', { localStorage: { getItem, setItem: vi.fn() } })
  const { useInputPreferences } = await import('./useInputPreferences')
  expect(getItem).not.toHaveBeenCalled()
  const state = useInputPreferences()
  expect(state.dictationLanguage.value).toBe(expected)
  const reads = getItem.mock.calls.length
  const next = useInputPreferences()
  expect(next.dictationLanguage).toBe(state.dictationLanguage)
  expect(getItem).toHaveBeenCalledTimes(reads)
})

it('persists a language and restores it after a module restart', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  } })
  vi.resetModules()
  const first = (await import('./useInputPreferences')).useInputPreferences()
  first.onDictationLanguageChange('zh-CN')
  vi.resetModules()
  const restored = (await import('./useInputPreferences')).useInputPreferences()
  expect(restored.dictationLanguage.value).toBe('zh')
  expect(restored.dictationLanguageOptions.value.some(option => option.value === 'zh')).toBe(true)
})

it('uses defaults if browser storage access throws', async () => {
  vi.resetModules()
  vi.stubGlobal('window', { get localStorage() { throw new Error('Storage unavailable') } })
  const state = (await import('./useInputPreferences')).useInputPreferences()
  expect(state.dictationLanguage.value).toBe('auto')
  state.onDictationLanguageChange('en')
  expect(state.dictationLanguage.value).toBe('en')
})
