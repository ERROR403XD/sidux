import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createThreadLiveCommandState } from './threadLiveCommandState'
import type { UiMessage } from '../types/codex'

function command(id: string, output = ''): UiMessage {
  return {
    id,
    role: 'system',
    text: `command-${id}`,
    messageType: 'commandExecution',
    commandExecution: {
      command: `command-${id}`,
      cwd: null,
      status: 'inProgress',
      aggregatedOutput: output,
      exitCode: null,
    },
  } as UiMessage
}

describe('thread live command state', () => {
  it('upserts by message identity without rewriting equivalent state', () => {
    const commandsByThreadId = ref<Record<string, UiMessage[]>>({ 'thread-1': [command('command-1')] })
    const state = createThreadLiveCommandState({ commandsByThreadId })
    const first = commandsByThreadId.value
    state.upsert('thread-1', command('command-1'))
    expect(commandsByThreadId.value).toBe(first)
    state.upsert('thread-1', command('command-2'))
    expect(state.getMessages('thread-1').map(message => message.id)).toEqual(['command-1', 'command-2'])
  })

  it('finds a message for output delta projection', () => {
    const commandsByThreadId = ref<Record<string, UiMessage[]>>({ 'thread-1': [command('command-1', 'existing')] })
    const state = createThreadLiveCommandState({ commandsByThreadId })
    expect(state.findMessage('thread-1', 'command-1')?.commandExecution?.aggregatedOutput).toBe('existing')
    expect(state.findMessage('thread-1', 'missing')).toBeUndefined()
  })

  it('removes commands persisted by id and clears empty threads', () => {
    const commandsByThreadId = ref<Record<string, UiMessage[]>>({
      'thread-1': [command('command-1'), command('command-2')],
    })
    const state = createThreadLiveCommandState({ commandsByThreadId })
    state.removePersistedIn('thread-1', [command('command-1')])
    expect(commandsByThreadId.value['thread-1'].map(message => message.id)).toEqual(['command-2'])
    state.removePersistedIn('thread-1', [command('command-2')])
    expect('thread-1' in commandsByThreadId.value).toBe(false)
  })

  it('clears, prunes, and resets without creating empty entries', () => {
    const commandsByThreadId = ref<Record<string, UiMessage[]>>({
      'thread-1': [command('command-1')],
      'thread-2': [command('command-2')],
    })
    const state = createThreadLiveCommandState({ commandsByThreadId })
    state.clear('thread-1')
    expect(Object.keys(commandsByThreadId.value)).toEqual(['thread-2'])
    state.prune(new Set(['thread-1']))
    expect(commandsByThreadId.value).toEqual({})
    commandsByThreadId.value = { 'thread-3': [command('command-3')] }
    state.reset()
    expect(commandsByThreadId.value).toEqual({})
    expect(state.getMessages('missing')).toEqual([])
  })
})
