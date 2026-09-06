import type { UiMessage } from './types/codex'

export type TaskIdentity = {
  id: string
  title: string
  parentThreadId: string
  nickname: string
  role: string
  path: string
  status: string
  canAcceptDirectInput: boolean | null
  preview: string
}
export type SubtaskEvent = {
  action: string
  status: string
  prompt: string
  targets: Array<{ id: string; path: string; status: string; summary: string }>
  targetCount: number
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}
const text = (value: unknown, limit = 2000): string => typeof value === 'string' ? value.slice(0, limit) : ''
export const taskId = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : ''
export const shortTaskId = (id: string): string => id.length > 14 ? `${id.slice(0, 4)}…${id.slice(-6)}` : id
export const taskStatusLabel = (status: string): string => ({ pendingInit: '准备中', running: '运行中', active: '运行中', interrupted: '已中断', completed: '已完成', errored: '出错', systemError: '出错', shutdown: '已关闭', notFound: '不可用', idle: '空闲', notLoaded: '未载入' }[status] || '状态未知')
export const taskActionLabel = (action: string): string => ({ spawnAgent: '创建子任务', sendInput: '发送指令', resumeAgent: '恢复子任务', wait: '等待子任务', closeAgent: '关闭子任务', sendMessage: '发送消息', followupTask: '继续子任务', interruptAgent: '中断子任务', listAgents: '查看子任务', started: '子任务启动', interacted: '子任务交互', interrupted: '子任务中断', completed: '子任务完成' }[action] || '子任务活动')

export function readTaskIdentity(value: unknown): TaskIdentity | null {
  const row = object(value)
  const id = taskId(row.id)
  if (!id) return null
  const source = object(object(row.source).subAgent ?? object(row.source).subagent)
  const spawn = object(source.thread_spawn)
  return {
    id,
    title: text(row.name || row.title || row.preview, 120) || shortTaskId(id),
    parentThreadId: taskId(row.parentThreadId) || taskId(spawn.parent_thread_id),
    nickname: text(row.agentNickname || spawn.agent_nickname, 120),
    role: text(row.agentRole || spawn.agent_role, 120),
    path: text(spawn.agent_path, 240),
    status: text(object(row.status).type, 40),
    canAcceptDirectInput: typeof row.canAcceptDirectInput === 'boolean' ? row.canAcceptDirectInput : null,
    preview: text(row.preview),
  }
}

export function normalizeSubtaskEvent(value: unknown): UiMessage | null {
  const row = object(value)
  if (typeof row.id !== 'string' || !row.id) return null
  let event: SubtaskEvent
  if (row.type === 'subAgentActivity') {
    const id = taskId(row.agentThreadId)
    if (!id) return null
    const action = text(row.kind, 40)
    const status = ({ started: 'running', interrupted: 'interrupted', completed: 'completed' } as Record<string, string>)[action] || ''
    event = { action, status: '', prompt: '', targets: [{ id, path: text(row.agentPath, 240), status, summary: '' }], targetCount: 1 }
  } else if (row.type === 'collabAgentToolCall') {
    const ids = [...new Set((Array.isArray(row.receiverThreadIds) ? row.receiverThreadIds : []).map(taskId).filter(Boolean))] as string[]
    const states = object(row.agentsStates)
    event = {
      action: text(row.tool, 40), status: text(row.status, 40), prompt: text(row.prompt, 4000), targetCount: ids.length,
      targets: ids.slice(0, 50).map(id => ({ id, path: '', status: text(object(states[id]).status, 40), summary: text(object(states[id]).message, 2000) })),
    }
  } else return null
  return { id: row.id, role: 'system', messageType: row.type, text: taskActionLabel(event.action), subtask: event }
}

/** The same item can arrive twice; a late start must not downgrade its completion. */
export function mergeSubtaskMessage(previous: UiMessage | undefined, next: UiMessage): UiMessage {
  if (previous?.subtask && next.subtask && previous.subtask.status !== 'inProgress' && next.subtask.status === 'inProgress') return previous
  return next
}

type Notification = { method: string; params: unknown }
const listeners = new Set<(event: Notification) => void>()
export function observeTaskNotification(event: Notification): void {
  for (const listener of listeners) listener(event)
}
export function subscribeTaskNotifications(listener: (event: Notification) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
