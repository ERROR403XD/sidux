import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadQueueUiState } from './threadQueueUiState'
import type { StoredQueuedMessage } from '../threadQueue'

function queuedMessage(id: string): StoredQueuedMessage {
  return {
    id,
    text: `message-${id}`,
    imageUrls: [],
    skills: [],
    fileAttachments: [],
    collaborationMode: 'default',
  }
}

describe('thread queue ui state', () => {
  it('reads and replaces queue state by thread', () => {
    const queuedMessagesByThreadId = ref<Record<string, StoredQueuedMessage[]>>({})
    const state = createThreadQueueUiState({
      queuedMessagesByThreadId,
      errorByThreadId: ref({}),
      globalError: ref(''),
      processingByThreadId: ref({}),
    })
    state.setState({ 'thread-1': [queuedMessage('queued-1')] })
    expect(state.getMessages('thread-1').map(message => message.id)).toEqual(['queued-1'])
    expect(state.getMessages('missing')).toEqual([])
    expect(state.findMessage('thread-1', 'queued-1')?.id).toBe('queued-1')
    expect(state.findMessage('thread-1', 'missing')).toBeUndefined()
  })

  it('tracks thread and global queue errors separately', () => {
    const errorByThreadId = ref<Record<string, string>>({})
    const globalError = ref('')
    const state = createThreadQueueUiState({
      queuedMessagesByThreadId: ref({}),
      errorByThreadId,
      globalError,
      processingByThreadId: ref({}),
    })
    state.setThreadError('thread-1', 'save failed')
    state.setGlobalError('load failed')
    state.clearThreadError('thread-2')
    expect(errorByThreadId.value).toEqual({ 'thread-1': 'save failed' })
    state.clearThreadError('thread-1')
    expect(errorByThreadId.value).toEqual({})
    state.clearGlobalError()
    expect(globalError.value).toBe('')
  })

  it('guards processing once per thread and clears it independently', () => {
    const processingByThreadId = ref<Record<string, boolean>>({ 'thread-1': true })
    const state = createThreadQueueUiState({
      queuedMessagesByThreadId: ref({}),
      errorByThreadId: ref({}),
      globalError: ref(''),
      processingByThreadId,
    })
    expect(state.beginProcessing('thread-1')).toBe(false)
    expect(state.beginProcessing('thread-2')).toBe(true)
    state.finishProcessing('thread-2')
    expect(processingByThreadId.value).toEqual({ 'thread-1': true })
    state.finishProcessing('thread-1')
    expect(processingByThreadId.value).toEqual({})
  })

  it('resets all queue ui state together', () => {
    const queuedMessagesByThreadId = ref<Record<string, StoredQueuedMessage[]>>({ 'thread-1': [queuedMessage('queued-1')] })
    const errorByThreadId = ref<Record<string, string>>({ 'thread-1': 'failed' })
    const globalError = ref('failed')
    const processingByThreadId = ref<Record<string, boolean>>({ 'thread-1': true })
    const state = createThreadQueueUiState({ queuedMessagesByThreadId, errorByThreadId, globalError, processingByThreadId })
    state.reset()
    expect(queuedMessagesByThreadId.value).toEqual({})
    expect(errorByThreadId.value).toEqual({})
    expect(globalError.value).toBe('')
    expect(processingByThreadId.value).toEqual({})
  })
})
