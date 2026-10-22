import { mergeSubtaskMessage } from './subtasks'
import { questionRefKey } from './userQuestions'
import type {
  CommandExecutionData,
  UiFileChange,
  UiMessage,
  UiPlanData,
  UiPlanStep,
} from './types/codex'

/** History may replace synthetic item-N IDs at completion. Ordinals are scoped to a turn. */
export function historyMessageKey(message: UiMessage): string {
  return message.turnId && message.historyOrdinal !== undefined
    ? JSON.stringify([message.turnId, message.role, message.messageType?.replace(/\.live$/, ''), message.historyOrdinal])
    : JSON.stringify([message.turnId || '', message.id])
}

export function sameMessageIdentity(a: UiMessage, b: UiMessage): boolean {
  if (a.turnId && b.turnId && a.turnId !== b.turnId) return false
  if (a.id === b.id) return true
  return !!a.turnId && a.turnId === b.turnId && a.historyOrdinal !== undefined && a.historyOrdinal === b.historyOrdinal && a.role === b.role && a.messageType?.replace(/\.live$/, '') === b.messageType?.replace(/\.live$/, '')
}

function areStringArraysEqual(first?: string[], second?: string[]): boolean {
  const left = Array.isArray(first) ? first : []
  const right = Array.isArray(second) ? second : []
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function areCommandExecutionsEqual(first?: CommandExecutionData, second?: CommandExecutionData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return first.status === second.status && first.aggregatedOutput === second.aggregatedOutput && first.exitCode === second.exitCode
}

function arePlanStepsEqual(first: UiPlanStep[] = [], second: UiPlanStep[] = []): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index]?.step !== second[index]?.step || first[index]?.status !== second[index]?.status) {
      return false
    }
  }
  return true
}

function arePlanDataEqual(first?: UiPlanData, second?: UiPlanData): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  return (
    first.explanation === second.explanation &&
    first.isStreaming === second.isStreaming &&
    arePlanStepsEqual(first.steps, second.steps)
  )
}

export function areMessageFieldsEqual(first: UiMessage, second: UiMessage): boolean {
  if (first.historyOrdinal !== second.historyOrdinal || first.clientUserMessageId !== second.clientUserMessageId) return false
  return (
    first.id === second.id &&
    first.role === second.role &&
    first.text === second.text &&
    first.delivery === second.delivery &&
    first.questionOrdinal === second.questionOrdinal &&
    JSON.stringify(first.questions) === JSON.stringify(second.questions) &&
    first.questionReply?.itemId === second.questionReply?.itemId &&
    first.questionReply?.turnId === second.questionReply?.turnId &&
    first.questionReply?.questionOrdinal === second.questionReply?.questionOrdinal &&
    areStringArraysEqual(first.images, second.images) &&
    areUiFileChangesEqual(first.fileChanges, second.fileChanges) &&
    first.fileChangeStatus === second.fileChangeStatus &&
    first.messageType === second.messageType &&
    first.rawPayload === second.rawPayload &&
    first.isUnhandled === second.isUnhandled &&
    JSON.stringify(first.compaction) === JSON.stringify(second.compaction) &&
    JSON.stringify(first.subtask) === JSON.stringify(second.subtask) &&
    areCommandExecutionsEqual(first.commandExecution, second.commandExecution) &&
    arePlanDataEqual(first.plan, second.plan) &&
    first.turnId === second.turnId &&
    first.turnIndex === second.turnIndex &&
    first.isAutomationRun === second.isAutomationRun &&
    first.automationDisplayName === second.automationDisplayName
  )
}

export function areMessageArraysEqual(first: readonly UiMessage[], second: readonly UiMessage[]): boolean {
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false
  }
  return true
}

function areUiFileChangesEqual(first?: UiFileChange[], second?: UiFileChange[]): boolean {
  if (!first && !second) return true
  if (!first || !second) return false
  if (first.length !== second.length) return false
  for (let index = 0; index < first.length; index += 1) {
    const firstChange = first[index]
    const secondChange = second[index]
    if (
      firstChange.path !== secondChange.path ||
      firstChange.operation !== secondChange.operation ||
      firstChange.movedToPath !== secondChange.movedToPath ||
      firstChange.diff !== secondChange.diff ||
      firstChange.addedLineCount !== secondChange.addedLineCount ||
      firstChange.removedLineCount !== secondChange.removedLineCount
    ) {
      return false
    }
  }
  return true
}

export function normalizeMessageText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function isOptimisticUserMessage(message: UiMessage): boolean {
  return message.messageType === 'userMessage.optimistic'
}

export function hasOptimisticUserMessages(messages: readonly UiMessage[]): boolean {
  return messages.some(isOptimisticUserMessage)
}

function comparableImageSource(value: string): string {
  try {
    const url = new URL(value, 'http://localhost')
    if (url.pathname === '/codex-local-image') return url.searchParams.get('path') || value
  } catch {}
  return value
}

// Local images also become file chips in the native echo; they are not extra attachments.
function nonImageAttachmentPaths(message: UiMessage): string[] {
  const imagePaths = new Set((message.images ?? []).map(comparableImageSource))
  return (message.fileAttachments ?? []).map(file => file.path).filter(path => !imagePaths.has(path))
}

export function hasEquivalentUserMessage(target: UiMessage, messages: readonly UiMessage[]): boolean {
  const targetText = normalizeMessageText(target.text)
  const targetImages = (target.images ?? []).map(comparableImageSource)
  const targetFiles = nonImageAttachmentPaths(target)
  const targetSkillCount = Array.isArray(target.skills) ? target.skills.length : 0

  return messages.some((message) => {
    if (message === target || message.role !== 'user' || isOptimisticUserMessage(message)) return false
    if (!target.turnId || message.turnId !== target.turnId) return false
    if (target.clientUserMessageId && message.clientUserMessageId) return target.clientUserMessageId === message.clientUserMessageId
    if (target.userMessageOrdinal !== undefined && message.userMessageOrdinal !== undefined && target.userMessageOrdinal !== message.userMessageOrdinal) return false
    const messageText = normalizeMessageText(message.text)
    const messageImages = (message.images ?? []).map(comparableImageSource)
    const messageFiles = nonImageAttachmentPaths(message)
    const messageSkillCount = Array.isArray(message.skills) ? message.skills.length : 0
    return (
      messageText === targetText &&
      areStringArraysEqual(messageImages, targetImages) &&
      areStringArraysEqual(messageFiles, targetFiles) &&
      messageSkillCount === targetSkillCount
    )
  })
}

export function mergeMessages(
  previous: UiMessage[],
  incoming: readonly UiMessage[],
  options?: { preserveMissing?: boolean },
): UiMessage[]
export function mergeMessages(
  previous: readonly UiMessage[],
  incoming: readonly UiMessage[],
  options?: { preserveMissing?: boolean },
): readonly UiMessage[]
export function mergeMessages(
  previous: readonly UiMessage[],
  incoming: readonly UiMessage[],
  options: { preserveMissing?: boolean } = {},
): readonly UiMessage[] {
  const previousById = new Map(previous.map(message => [JSON.stringify([message.turnId || '', message.id]), message]))
  const previousByOrdinal = new Map(previous.filter(message => message.historyOrdinal !== undefined).map(message => [historyMessageKey(message), message]))
  const optimistic = previous.filter(isOptimisticUserMessage)
  const consumed = new Set<UiMessage>()
  const replacements = new Map<UiMessage, UiMessage>()
  const appended: UiMessage[] = []
  const mergedIncoming = incoming.map(message => {
    let before = previousById.get(JSON.stringify([message.turnId || '', message.id]))
      || (message.historyOrdinal !== undefined ? previousByOrdinal.get(historyMessageKey(message)) : undefined)
    if (!before && message.role === 'user') {
      before = optimistic.find(row => !consumed.has(row) && hasEquivalentUserMessage(row, [message]))
    }
    const next = before && areMessageFieldsEqual(before, message) ? before : mergeSubtaskMessage(before, message)
    if (before) {
      consumed.add(before)
      replacements.set(before, next)
    } else appended.push(next)
    return next
  })
  if (options.preserveMissing !== true) return areMessageArraysEqual(previous, mergedIncoming) ? previous : mergedIncoming
  const incomingQuestionKeys = new Set(incoming.flatMap(message => message.questions?.length && message.turnId && message.questionOrdinal !== undefined
    ? [questionRefKey({ itemId: message.id, turnId: message.turnId, questionOrdinal: message.questionOrdinal })] : []))
  const retained = previous.filter(message => consumed.has(message) || !(message.questions?.length && message.turnId && message.questionOrdinal !== undefined
    && incomingQuestionKeys.has(questionRefKey({ itemId: message.id, turnId: message.turnId, questionOrdinal: message.questionOrdinal }))))
  const merged = [...retained.map(message => replacements.get(message) || message), ...appended]

  return areMessageArraysEqual(previous, merged) ? previous : merged
}

export function removeRedundantLiveAgentMessages(previous: UiMessage[], incoming: readonly UiMessage[]): UiMessage[]
export function removeRedundantLiveAgentMessages(previous: readonly UiMessage[], incoming: readonly UiMessage[]): readonly UiMessage[]
export function removeRedundantLiveAgentMessages(previous: readonly UiMessage[], incoming: readonly UiMessage[]): readonly UiMessage[] {
  const incomingMessageIds = new Set(incoming.map((message) => message.id))

  if (incomingMessageIds.size === 0) return previous

  const next = previous.filter((message) => {
    if (message.messageType !== 'agentMessage.live') return true
    if (incoming.some(row => sameMessageIdentity(row, message))) return false
    if (message.questions?.length) return true
    const normalized = normalizeMessageText(message.text)
    if (normalized.length === 0) return false
    return true
  })

  return next.length === previous.length ? previous : next
}

export function removePersistedLiveMessages(previous: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const incomingIds = new Set(incoming.map((message) => message.id))
  const next = previous.filter((message) => !incomingIds.has(message.id))
  return next.length === previous.length ? previous : next
}

export function upsertMessage(previous: UiMessage[], nextMessage: UiMessage): UiMessage[]
export function upsertMessage(previous: readonly UiMessage[], nextMessage: UiMessage): readonly UiMessage[]
export function upsertMessage(previous: readonly UiMessage[], nextMessage: UiMessage): readonly UiMessage[] {
  const existingIndex = previous.findIndex((message) => message.id === nextMessage.id)
  if (existingIndex < 0) {
    return [...previous, nextMessage]
  }

  const existing = previous[existingIndex]
  if (areMessageFieldsEqual(existing, nextMessage)) {
    return previous
  }

  const next = [...previous]
  next.splice(existingIndex, 1, nextMessage)
  return next
}

export function combineHistoryAndLive(history: readonly UiMessage[], live: readonly UiMessage[]): UiMessage[] {
  const indexed = new Map(history.map(message => [JSON.stringify([message.turnId || '', message.id]), message]))
  const result = [...history]
  for (const message of live) {
    const persisted = indexed.get(JSON.stringify([message.turnId || '', message.id]))
      || (!message.turnId ? history.find(row => row.id === message.id) : undefined)
    if (!persisted) {
      result.push(message)
      indexed.set(JSON.stringify([message.turnId || '', message.id]), message)
    }
    // The canonical record owns a completed item. A longer live delta may precede the next snapshot.
    else if (message.messageType === 'agentMessage.live' && message.text.length > persisted.text.length && message.text.startsWith(persisted.text)) {
      const index = result.indexOf(persisted)
      if (index >= 0) result[index] = { ...persisted, text: message.text }
    }
  }
  return result
}

/** Native item IDs may be reconstructed and reused by a different turn. */
export function messageRenderKey(message: UiMessage, threadId: string): string {
  return JSON.stringify([threadId, message.turnId || '', message.id])
}
