import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useConversationCommandProjection } from './conversationCommandProjection'
import type { UiMessage } from '../types/codex'

function command(id: string, status: 'inProgress' | 'completed' = 'completed'): UiMessage {
  return {
    id,
    role: 'assistant',
    text: '',
    messageType: 'commandExecution',
    commandExecution: {
      command: id,
      cwd: null,
      status,
      aggregatedOutput: '',
      exitCode: 0,
    },
  }
}

function assistant(id: string): UiMessage {
  return { id, role: 'assistant', text: 'response' }
}

function key(message: UiMessage): string {
  return message.id
}

describe('conversation command projection', () => {
  it('groups consecutive commands under the latest command row', () => {
    const first = command('first')
    const second = command('second')
    const result = useConversationCommandProjection(ref([first, second]), key)

    expect(result.groupedCommandsByLatestId.value).toEqual({ second: [first] })
    expect(result.hiddenGroupedCommandIds.value).toEqual(new Set(['first']))
  })

  it('does not group commands separated by an assistant message', () => {
    const first = command('first')
    const response = assistant('response')
    const second = command('second')
    const result = useConversationCommandProjection(ref([first, response, second]), key)

    expect(result.groupedCommandsByLatestId.value).toEqual({})
    expect(result.hiddenGroupedCommandIds.value).toEqual(new Set())
  })

  it('reports the latest in-progress command id', () => {
    const earlier = command('earlier')
    const current = command('current', 'inProgress')
    const result = useConversationCommandProjection(ref([earlier, current]), key)

    expect(result.activeCommandMessageId.value).toBe('current')
  })
})
