import { computed, type ComputedRef, type Ref } from 'vue'
import type { UiFileChange, UiMessage } from '../types/codex'

export type TurnFileChangeSummary = {
  changes: UiFileChange[]
  sourceMessageIds: string[]
  source: 'assistant' | 'metadata'
  turnId: string
}

export type ConversationFileChangeProjection = {
  anchoredFileChangeSummaryByAnchorId: ComputedRef<Record<string, TurnFileChangeSummary>>
  standaloneFileChangeSummaryByMessageId: ComputedRef<Record<string, TurnFileChangeSummary>>
  hiddenFileChangeMessageIds: ComputedRef<Set<string>>
}

function isFileChangeMessage(message: UiMessage): boolean {
  return message.messageType === 'fileChange'
    && message.fileChangeStatus === 'completed'
    && Array.isArray(message.fileChanges)
    && message.fileChanges.length > 0
}

function isAssistantAnchorMessage(message: UiMessage): boolean {
  return message.role === 'assistant'
    && message.messageType !== 'commandExecution'
    && message.messageType !== 'fileChange'
    && message.messageType !== 'worked'
    && !(message.messageType ?? '').endsWith('.live')
}

function mergeFileChangeDiff(first: string, second: string): string {
  if (!first) return second
  if (!second || first === second) return first
  return `${first}\n${second}`.trim()
}

function mergeFileChangeEntry(first: UiFileChange, second: UiFileChange): UiFileChange {
  const operation = first.operation === 'add' || second.operation === 'add'
    ? 'add'
    : first.operation === 'delete' || second.operation === 'delete'
      ? 'delete'
      : 'update'
  return {
    path: second.path || first.path,
    operation,
    movedToPath: second.movedToPath ?? first.movedToPath ?? null,
    diff: mergeFileChangeDiff(first.diff, second.diff),
    addedLineCount: first.addedLineCount + second.addedLineCount,
    removedLineCount: first.removedLineCount + second.removedLineCount,
  }
}

function compareFileChanges(first: UiFileChange, second: UiFileChange): number {
  const firstRank = first.operation === 'add' ? 0 : first.operation === 'update' ? 1 : 2
  const secondRank = second.operation === 'add' ? 0 : second.operation === 'update' ? 1 : 2
  if (firstRank !== secondRank) return firstRank - secondRank
  const firstPath = `${first.path}\u0000${first.movedToPath ?? ''}`
  const secondPath = `${second.path}\u0000${second.movedToPath ?? ''}`
  return firstPath.localeCompare(secondPath)
}

function aggregateFileChanges(changes: UiFileChange[]): UiFileChange[] {
  const byPath = new Map<string, UiFileChange>()
  for (const change of changes) {
    const key = `${change.path}\u0000${change.movedToPath ?? ''}`
    const previous = byPath.get(key)
    byPath.set(key, previous ? mergeFileChangeEntry(previous, change) : { ...change })
  }
  return Array.from(byPath.values()).sort(compareFileChanges)
}

function messageTurnKey(message: UiMessage, renderKey: (message: UiMessage) => string): string {
  return typeof message.turnIndex === 'number' ? `turn:${message.turnIndex}` : `message:${renderKey(message)}`
}

export function useConversationFileChangeProjection(
  messages: Ref<UiMessage[]>,
  renderKey: (message: UiMessage) => string,
): ConversationFileChangeProjection {
  const anchoredFileChangeSummaryByAnchorId = computed<Record<string, TurnFileChangeSummary>>(() => {
    const assistantAnchorIdByTurnKey = new Map<string, string>()
    const assistantSummaryByAnchorId = new Map<string, TurnFileChangeSummary>()
    const fileChangeMessagesByTurnKey = new Map<string, UiMessage[]>()

    for (const message of messages.value) {
      if (isAssistantAnchorMessage(message) && typeof message.turnIndex === 'number') {
        assistantAnchorIdByTurnKey.set(`turn:${message.turnIndex}`, renderKey(message))
        if (Array.isArray(message.fileChanges) && message.fileChanges.length > 0) {
          assistantSummaryByAnchorId.set(renderKey(message), {
            changes: aggregateFileChanges(message.fileChanges),
            sourceMessageIds: [],
            source: 'assistant',
            turnId: message.turnId ?? '',
          })
        }
      }

      if (!isFileChangeMessage(message)) continue
      const turnKey = messageTurnKey(message, renderKey)
      const current = fileChangeMessagesByTurnKey.get(turnKey)
      if (current) current.push(message)
      else fileChangeMessagesByTurnKey.set(turnKey, [message])
    }

    const summaries: Record<string, TurnFileChangeSummary> = {}
    for (const [turnKey, fileChangeMessages] of fileChangeMessagesByTurnKey.entries()) {
      const anchorId = assistantAnchorIdByTurnKey.get(turnKey)
      if (!anchorId) continue
      const assistantTurnId = assistantSummaryByAnchorId.get(anchorId)?.turnId ?? ''
      summaries[anchorId] = {
        changes: aggregateFileChanges(fileChangeMessages.flatMap((message) => message.fileChanges ?? [])),
        sourceMessageIds: fileChangeMessages.map(renderKey),
        source: 'metadata',
        turnId: fileChangeMessages.find((message) => typeof message.turnId === 'string' && message.turnId.length > 0)?.turnId ?? assistantTurnId,
      }
    }

    for (const [anchorId, summary] of assistantSummaryByAnchorId.entries()) {
      if (!summaries[anchorId]) summaries[anchorId] = summary
    }

    return summaries
  })

  const standaloneFileChangeSummaryByMessageId = computed<Record<string, TurnFileChangeSummary>>(() => {
    const assistantAnchorIdByTurnKey = new Map<string, string>()
    const fileChangeMessagesByTurnKey = new Map<string, UiMessage[]>()

    for (const message of messages.value) {
      if (isAssistantAnchorMessage(message) && typeof message.turnIndex === 'number') {
        assistantAnchorIdByTurnKey.set(`turn:${message.turnIndex}`, renderKey(message))
      }

      if (!isFileChangeMessage(message)) continue
      const turnKey = messageTurnKey(message, renderKey)
      const current = fileChangeMessagesByTurnKey.get(turnKey)
      if (current) current.push(message)
      else fileChangeMessagesByTurnKey.set(turnKey, [message])
    }

    const summaries: Record<string, TurnFileChangeSummary> = {}
    for (const [turnKey, fileChangeMessages] of fileChangeMessagesByTurnKey.entries()) {
      if (assistantAnchorIdByTurnKey.has(turnKey)) continue
      const visibleMessage = fileChangeMessages[fileChangeMessages.length - 1]
      if (!visibleMessage) continue
      summaries[renderKey(visibleMessage)] = {
        changes: aggregateFileChanges(fileChangeMessages.flatMap((message) => message.fileChanges ?? [])),
        sourceMessageIds: fileChangeMessages.map(renderKey),
        source: 'metadata',
        turnId: visibleMessage.turnId ?? fileChangeMessages.find((message) => typeof message.turnId === 'string' && message.turnId.length > 0)?.turnId ?? '',
      }
    }

    return summaries
  })

  const hiddenFileChangeMessageIds = computed(() => {
    const next = new Set<string>()
    for (const summary of Object.values(anchoredFileChangeSummaryByAnchorId.value)) {
      for (const messageId of summary.sourceMessageIds) next.add(messageId)
    }
    for (const [messageId, summary] of Object.entries(standaloneFileChangeSummaryByMessageId.value)) {
      for (const sourceMessageId of summary.sourceMessageIds) {
        if (sourceMessageId !== messageId) next.add(sourceMessageId)
      }
    }
    return next
  })

  return {
    anchoredFileChangeSummaryByAnchorId,
    standaloneFileChangeSummaryByMessageId,
    hiddenFileChangeMessageIds,
  }
}
