import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { createThreadOlderPageState } from './threadOlderPageState'

function createState() {
  const hasMoreByThreadId = ref<Record<string, boolean>>({})
  const loadingByThreadId = ref<Record<string, boolean>>({})
  const state = createThreadOlderPageState({ hasMoreByThreadId, loadingByThreadId })
  return { hasMoreByThreadId, loadingByThreadId, state }
}

describe('thread older page state', () => {
  it('guards duplicate loads until the current page finishes', () => {
    const test = createState()
    test.state.setHasMore('thread-1', true)
    expect(test.state.begin('thread-1')).toBe(true)
    expect(test.state.begin('thread-1')).toBe(false)
    test.state.complete('thread-1', true)
    test.state.finish('thread-1')
    expect(test.state.begin('thread-1')).toBe(true)
  })

  it('does not start when no older page remains', () => {
    const test = createState()
    test.state.setHasMore('thread-1', false)
    expect(test.state.begin('thread-1')).toBe(false)
    expect(test.loadingByThreadId.value).toEqual({})
  })

  it('preserves completion state while clearing loading separately', () => {
    const test = createState()
    test.state.setHasMore('thread-1', true)
    test.state.begin('thread-1')
    test.state.complete('thread-1', false)
    test.state.finish('thread-1')
    expect(test.hasMoreByThreadId.value['thread-1']).toBe(false)
    expect(test.loadingByThreadId.value['thread-1']).toBe(false)
  })

  it('updates reactive maps', async () => {
    const test = createState()
    test.state.setHasMore('thread-1', true)
    test.state.begin('thread-1')
    await nextTick()
    expect(test.loadingByThreadId.value['thread-1']).toBe(true)
  })

  it('resets both maps together', () => {
    const test = createState()
    test.state.setHasMore('thread-1', true)
    test.state.setHasMore('thread-2', true)
    test.state.begin('thread-2')
    test.state.reset()
    expect(test.hasMoreByThreadId.value).toEqual({})
    expect(test.loadingByThreadId.value).toEqual({})
  })
})
