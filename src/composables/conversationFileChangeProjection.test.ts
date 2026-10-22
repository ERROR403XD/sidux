import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useConversationFileChangeProjection } from './conversationFileChangeProjection'
import type { UiFileChange, UiMessage } from '../types/codex'

function change(path: string, addedLineCount = 1): UiFileChange {
  return { path, operation: 'update', diff: `diff --git a/${path}`, addedLineCount, removedLineCount: 0 }
}

function fileChangeMessage(id: string, changes: UiFileChange[], turnIndex = 1): UiMessage {
  return { id, role: 'assistant', text: '', messageType: 'fileChange', fileChangeStatus: 'completed', fileChanges: changes, turnIndex }
}

function assistant(id: string, turnIndex = 1): UiMessage {
  return { id, role: 'assistant', text: 'response', turnIndex }
}

function key(message: UiMessage): string {
  return message.id
}

describe('conversation file change projection', () => {
  it('anchors completed metadata changes to the assistant response in the same turn', () => {
    const first = fileChangeMessage('first', [change('a.txt')])
    const second = fileChangeMessage('second', [change('b.txt')])
    const anchor = assistant('response')
    const result = useConversationFileChangeProjection(ref([first, second, anchor]), key)

    expect(result.anchoredFileChangeSummaryByAnchorId.value.response).toMatchObject({
      source: 'metadata',
      sourceMessageIds: ['first', 'second'],
    })
    expect(result.hiddenFileChangeMessageIds.value).toEqual(new Set(['first', 'second']))
  })

  it('keeps a standalone latest row when no assistant anchor exists', () => {
    const first = fileChangeMessage('first', [change('a.txt')])
    const second = fileChangeMessage('second', [change('b.txt')])
    const result = useConversationFileChangeProjection(ref([first, second]), key)

    expect(result.standaloneFileChangeSummaryByMessageId.value.second).toMatchObject({ sourceMessageIds: ['first', 'second'] })
    expect(result.hiddenFileChangeMessageIds.value).toEqual(new Set(['first']))
  })

  it('merges duplicate paths and sums line counts', () => {
    const first = fileChangeMessage('first', [change('same.txt', 1)])
    const second = fileChangeMessage('second', [change('same.txt', 2)])
    const result = useConversationFileChangeProjection(ref([first, second]), key)
    const summary = result.standaloneFileChangeSummaryByMessageId.value.second

    expect(summary?.changes).toHaveLength(1)
    expect(summary?.changes[0]).toMatchObject({ path: 'same.txt', addedLineCount: 3 })
  })
})
