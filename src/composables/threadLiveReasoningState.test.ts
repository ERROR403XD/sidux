import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadLiveReasoningState } from './threadLiveReasoningState'

describe('thread live reasoning state', () => {
  it('appends through the existing normalized-text contract', () => {
    const textByThreadId = ref<Record<string, string>>({})
    const state = createThreadLiveReasoningState({ textByThreadId })
    state.append('thread-1', ' first ')
    state.append('thread-1', 'second ')
    expect(textByThreadId.value['thread-1']).toBe('firstsecond')
    expect(state.getText('thread-1')).toBe('firstsecond')
  })

  it('removes an entry when normalized text becomes empty', () => {
    const textByThreadId = ref<Record<string, string>>({ 'thread-1': 'existing' })
    const state = createThreadLiveReasoningState({ textByThreadId })
    state.setText('thread-1', '   ')
    expect('thread-1' in textByThreadId.value).toBe(false)
    expect(state.getText('thread-1')).toBe('')
  })

  it('normalizes section-break writes and ignores empty reasoning', () => {
    const textByThreadId = ref<Record<string, string>>({ 'thread-1': 'existing' })
    const state = createThreadLiveReasoningState({ textByThreadId })
    state.appendSectionBreak('thread-1')
    expect(textByThreadId.value['thread-1']).toBe('existing')
    const first = textByThreadId.value
    state.appendSectionBreak('thread-1')
    expect(textByThreadId.value).toBe(first)
    state.appendSectionBreak('thread-2')
    expect('thread-2' in textByThreadId.value).toBe(false)
  })

  it('clears, prunes, and resets state', () => {
    const textByThreadId = ref<Record<string, string>>({
      'thread-1': 'first',
      'thread-2': 'second',
    })
    const state = createThreadLiveReasoningState({ textByThreadId })
    state.clear('thread-1')
    expect(Object.keys(textByThreadId.value)).toEqual(['thread-2'])
    state.prune(new Set(['thread-1']))
    expect(textByThreadId.value).toEqual({})
    textByThreadId.value = { 'thread-3': 'third' }
    state.reset()
    expect(textByThreadId.value).toEqual({})
  })
})
