import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThreadUsageController } from './threadUsageController'
import { createThreadTerminalController } from './threadTerminalController'
import type { UiThreadTokenUsage } from '../types/codex'

const TOKEN_KEY = 'codex-web-local.thread-token-usage.v1'
const TERMINAL_KEY = 'codex-web-local.thread-terminal-open.v1'
const usage: UiThreadTokenUsage = {
  total: { totalTokens: 50, inputTokens: 40, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 5 },
  last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 5 },
  modelContextWindow: 100, currentContextTokens: 30, remainingContextTokens: 70, remainingContextPercent: 70,
}
function setup(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))
  const setItem = vi.fn((key: string, value: string) => { values.set(key, value) })
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem } })
  const selected = ref('a')
  const options = { getSelectedThreadId: () => selected.value }
  return { usage: createThreadUsageController(options), terminal: createThreadTerminalController(options), selected, values, setItem, options }
}
afterEach(() => vi.unstubAllGlobals())

describe('usage persistence owner', () => {
  it('normalizes counts, recomputes context fields and omits invalid rows during restoration', () => {
    const test = setup({ [TOKEN_KEY]: JSON.stringify({
      a: { total: { totalTokens: -3, inputTokens: '8.9', outputTokens: 'bad' }, last: { totalTokens: '120.6' }, modelContextWindow: '100.9', remainingContextPercent: 999 },
      invalid: { total: {}, last: [] }, '': usage,
    }) })
    expect(test.usage.selectedThreadTokenUsage.value).toMatchObject({
      total: { totalTokens: 0, inputTokens: 8, outputTokens: 0 }, currentContextTokens: 120,
      modelContextWindow: 100, remainingContextTokens: 0, remainingContextPercent: 0,
    })
    test.selected.value = 'invalid'
    expect(test.usage.selectedThreadTokenUsage.value).toBeNull()
    expect(test.setItem).not.toHaveBeenCalled()
  })

  it.each([null, 0])('keeps percent unknown for an absent or zero context window %s', windowSize => {
    const test = setup({ [TOKEN_KEY]: JSON.stringify({ a: { ...usage, modelContextWindow: windowSize } }) })
    expect(test.usage.selectedThreadTokenUsage.value?.remainingContextPercent).toBeNull()
    expect(test.usage.selectedThreadTokenUsage.value?.remainingContextTokens).toBe(windowSize === null ? null : 0)
  })

  it('trims usage IDs, ignores empty IDs and unchanged updates, and deletes only existing rows', () => {
    const test = setup()
    test.usage.setThreadTokenUsage(' ', usage)
    test.usage.setThreadTokenUsage('missing', null)
    expect(test.setItem).not.toHaveBeenCalled()
    test.usage.setThreadTokenUsage(' a ', usage)
    test.usage.setThreadTokenUsage('a', { ...usage })
    expect(test.setItem).toHaveBeenCalledOnce()
    expect(JSON.parse(test.values.get(TOKEN_KEY)!)).toEqual({ a: usage })
    test.usage.setThreadTokenUsage(' a ', null)
    test.usage.setThreadTokenUsage('a', null)
    expect(test.setItem).toHaveBeenCalledTimes(2)
    expect(test.usage.selectedThreadTokenUsage.value).toBeNull()
    expect(JSON.parse(test.values.get(TOKEN_KEY)!)).toEqual({})
  })

  it('prunes and resets volatile usage without erasing persisted state for filtered conversations', () => {
    const test = setup({ [TOKEN_KEY]: JSON.stringify({ a: usage, b: usage }) })
    test.usage.prune(new Set(['a']))
    expect(test.usage.selectedThreadTokenUsage.value).toEqual(usage)
    test.selected.value = 'b'
    expect(test.usage.selectedThreadTokenUsage.value).toBeNull()
    test.usage.reset()
    expect(test.setItem).not.toHaveBeenCalled()
    expect(createThreadUsageController(test.options).selectedThreadTokenUsage.value).toEqual(usage)
  })
})

describe('terminal preference owner', () => {
  it('restores only boolean entries and retains preferences while selection changes', () => {
    const test = setup({ [TERMINAL_KEY]: JSON.stringify({ a: true, b: false, invalid: 'true', '': true }) })
    expect(test.terminal.selectedThreadTerminalOpen.value).toBe(true)
    for (const id of ['b', 'invalid', '']) {
      test.selected.value = id
      expect(test.terminal.selectedThreadTerminalOpen.value).toBe(false)
    }
    test.selected.value = 'a'
    expect(test.terminal.selectedThreadTerminalOpen.value).toBe(true)
    expect(test.setItem).not.toHaveBeenCalled()
  })

  it('persists explicit and toggle commands while keeping other conversation preferences', () => {
    const test = setup()
    test.terminal.setThreadTerminalOpen('', true)
    test.selected.value = ''
    test.terminal.toggleSelectedThreadTerminal()
    expect(test.setItem).not.toHaveBeenCalled()
    test.terminal.setThreadTerminalOpen('b', true)
    test.selected.value = 'a'
    test.terminal.toggleSelectedThreadTerminal()
    expect(test.terminal.selectedThreadTerminalOpen.value).toBe(true)
    test.terminal.toggleSelectedThreadTerminal()
    expect(JSON.parse(test.values.get(TERMINAL_KEY)!)).toEqual({ b: true })
    test.selected.value = 'b'
    expect(createThreadTerminalController(test.options).selectedThreadTerminalOpen.value).toBe(true)
  })
})

describe('unavailable browser persistence', () => {
  it('constructs and updates both owners without window', () => {
    vi.stubGlobal('window', undefined)
    const options = { getSelectedThreadId: () => 'a' }
    const tokens = createThreadUsageController(options)
    const terminal = createThreadTerminalController(options)
    tokens.setThreadTokenUsage('a', usage)
    terminal.toggleSelectedThreadTerminal()
    expect(tokens.selectedThreadTokenUsage.value).toEqual(usage)
    expect(terminal.selectedThreadTerminalOpen.value).toBe(true)
  })

  it('tolerates storage read failures and preserves the existing write-error contract', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('read denied') }, setItem: () => { throw new Error('write denied') } } })
    const options = { getSelectedThreadId: () => 'a' }
    const tokens = createThreadUsageController(options)
    const terminal = createThreadTerminalController(options)
    expect(tokens.selectedThreadTokenUsage.value).toBeNull()
    expect(terminal.selectedThreadTerminalOpen.value).toBe(false)
    expect(() => tokens.setThreadTokenUsage('a', usage)).toThrow('write denied')
    expect(() => terminal.toggleSelectedThreadTerminal()).toThrow('write denied')
  })
})
