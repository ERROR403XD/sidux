import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { createThreadLoadedState } from './threadLoadedState'

function createState() {
  const loadedByThreadId = ref<Record<string, boolean>>({})
  const state = createThreadLoadedState({ loadedByThreadId })
  return { loadedByThreadId, state }
}

describe('thread loaded state', () => {
  it('reports and marks loaded threads', () => {
    const test = createState()
    expect(test.state.isLoaded('thread-1')).toBe(false)
    test.state.markLoaded('thread-1')
    expect(test.state.isLoaded('thread-1')).toBe(true)
  })

  it('updates the reactive map', async () => {
    const test = createState()
    test.state.markLoaded('thread-1')
    await nextTick()
    expect(test.loadedByThreadId.value['thread-1']).toBe(true)
  })

  it('clears one thread', () => {
    const test = createState()
    test.state.markLoaded('thread-1')
    test.state.clear('thread-1')
    expect(test.state.isLoaded('thread-1')).toBe(false)
    expect(test.loadedByThreadId.value).toEqual({})
  })

  it('prunes absent threads and keeps active loaded markers', () => {
    const test = createState()
    test.state.markLoaded('thread-1')
    test.state.markLoaded('thread-2')
    test.state.prune(new Set(['thread-2']))
    expect(test.state.isLoaded('thread-1')).toBe(false)
    expect(test.state.isLoaded('thread-2')).toBe(true)
  })

  it('resets all markers', () => {
    const test = createState()
    test.state.markLoaded('thread-1')
    test.state.reset()
    expect(test.state.isLoaded('thread-1')).toBe(false)
    expect(test.loadedByThreadId.value).toEqual({})
  })
})
