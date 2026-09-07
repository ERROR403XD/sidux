import { capabilityValue } from './modelCapabilities.js'
import { readDeliveryView, type DeliveryView } from './delivery.js'
export type StoredQueuedMessage = {
  delivery?: DeliveryView
  model?: string
  effort?: string
  serviceTier?: string | null
  id: string
  text: string
  imageUrls: string[]
  skills: Array<{ name: string; path: string }>
  fileAttachments: Array<{ label: string; path: string; fsPath: string }>
  collaborationMode: 'default' | 'plan'
}

export type ThreadQueueState = Record<string, StoredQueuedMessage[]>
export type ThreadQueueOperation =
  | { type: 'add'; threadId: string; message: StoredQueuedMessage; beforeId?: string }
  | { type: 'remove' | 'abandon' | 'resume' | 'steer' | 'reconcile'; threadId: string; messageId: string; revision?: number }
  | { type: 'edit' | 'update'; threadId: string; messageId: string; revision: number; editToken: string; message?: StoredQueuedMessage }
  | { type: 'move'; threadId: string; messageId: string; targetId: string; revision?: number }

export type ThreadQueueResult = { state: ThreadQueueState; removed?: StoredQueuedMessage; delivered?: { id: string; turnId: string } }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function normalizeStoredQueuedMessage(value: unknown): StoredQueuedMessage | null {
  const row = record(value)
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!id) return null
  return {
    id,
    ...(row.delivery !== undefined ? { delivery: readDeliveryView(row.delivery) } : {}),
    ...(capabilityValue(row.model) ? { model: capabilityValue(row.model) } : {}),
    ...(typeof row.effort === 'string' ? { effort: capabilityValue(row.effort) } : {}),
    ...(row.serviceTier === null ? { serviceTier: null } : capabilityValue(row.serviceTier) ? { serviceTier: capabilityValue(row.serviceTier) } : {}),
    text: typeof row.text === 'string' ? row.text : '',
    imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [],
    skills: (Array.isArray(row.skills) ? row.skills : []).flatMap((value) => {
      const item = record(value)
      return typeof item.name === 'string' && typeof item.path === 'string' && item.name.trim() && item.path.trim()
        ? [{ name: item.name.trim(), path: item.path.trim() }] : []
    }),
    fileAttachments: (Array.isArray(row.fileAttachments) ? row.fileAttachments : []).flatMap((value) => {
      const item = record(value)
      return typeof item.label === 'string' && typeof item.path === 'string' && typeof item.fsPath === 'string' && item.label.trim() && item.path.trim() && item.fsPath.trim()
        ? [{ label: item.label.trim(), path: item.path.trim(), fsPath: item.fsPath.trim() }] : []
    }),
    collaborationMode: row.collaborationMode === 'plan' ? 'plan' : 'default',
  }
}

export function normalizeThreadQueueState(value: unknown): ThreadQueueState {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([id, rows]) => {
    if (!id.trim() || !Array.isArray(rows)) return []
    const messages = rows.flatMap((row) => {
      const message = normalizeStoredQueuedMessage(row)
      return message ? [message] : []
    })
    return messages.length ? [[id.trim(), messages]] : []
  }))
}

// Apply only the requested change to the latest server state. A missing message
// is never recreated by remove/move, even when another page has an older view.
export function applyThreadQueueOperation(state: ThreadQueueState, input: unknown): ThreadQueueResult {
  const operation = record(input)
  const threadId = typeof operation.threadId === 'string' ? operation.threadId.trim() : ''
  if (!threadId) throw new Error('缺少会话 ID')
  const queue = [...(state[threadId] ?? [])]
  let removed: StoredQueuedMessage | undefined
  if (operation.type === 'add') {
    const message = normalizeStoredQueuedMessage(operation.message)
    if (!message) throw new Error('无效的排队消息')
    if (!queue.some((row) => row.id === message.id)) {
      const before = queue.findIndex((row) => row.id === operation.beforeId)
      queue.splice(before < 0 ? queue.length : before, 0, message)
    }
  } else if (operation.type === 'remove' || operation.type === 'move') {
    const index = queue.findIndex((row) => row.id === operation.messageId)
    if (index < 0) throw new Error('该消息已发送或已被其他页面移除，请刷新队列')
    if (operation.type === 'remove') {
      removed = queue.splice(index, 1)[0]
    } else {
      const target = queue.findIndex((row) => row.id === operation.targetId)
      if (target < 0) throw new Error('排序目标已变化，请刷新队列')
      const message = queue.splice(index, 1)[0]!
      queue.splice(target, 0, message)
    }
  } else {
    throw new Error('无效的队列操作')
  }
  const next = { ...state }
  if (queue.length) next[threadId] = queue
  else delete next[threadId]
  return { state: next, ...(removed ? { removed } : {}) }
}
