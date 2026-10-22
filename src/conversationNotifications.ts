import { isFinalQuotaInterruption } from './sidebarThreadFilter.js'
import { classifyThreadInterruption } from './threadInterruption.js'
import { asRecord, extractThreadIdFromNotification, readString } from './composables/threadNotificationValues.js'
import { goalStatusLabels, type ThreadGoal } from './threadGoal.js'
import { automaticResumeStartedMethod, type AutomaticResumeSource } from './threadAutomaticResume.js'

export const conversationNoticeStates = ['completed', 'quota', 'interrupted', 'automation', 'resumeStarted'] as const
export type ConversationNoticeState = typeof conversationNoticeStates[number]
export type ConversationNoticePreferences = {
  postEnabled: boolean
  goalProgressEnabled: boolean
  states: Record<ConversationNoticeState, boolean>
}
export type ConversationNotice = { threadId: string; turnId: string; goalProgress?: boolean } & (
  { state: Exclude<ConversationNoticeState, 'resumeStarted'> }
  | { state: 'resumeStarted'; deliveryId: string; resumeSource: AutomaticResumeSource }
)
export const conversationNoticeLabels: Record<ConversationNoticeState, string> = {
  completed: '会话任务已完成',
  quota: '会话额度受限',
  interrupted: '会话任务已中断',
  automation: '自动化任务已完成',
  resumeStarted: '自动续跑已启动',
}
export function defaultConversationNoticePreferences(): ConversationNoticePreferences {
  return { postEnabled: false, goalProgressEnabled: false, states: { completed: true, quota: true, interrupted: true, automation: true, resumeStarted: false } }
}
export function validateConversationNoticePreferences(value: unknown): ConversationNoticePreferences {
  const record = asRecord(value)
  const states = asRecord(record?.states)
  if (typeof record?.postEnabled !== 'boolean' || (record.goalProgressEnabled !== undefined && typeof record.goalProgressEnabled !== 'boolean') || !states || conversationNoticeStates.some(key => !(key === 'resumeStarted' && states[key] === undefined) && typeof states[key] !== 'boolean')) {
    throw new Error('会话通知设置格式错误。')
  }
  return { postEnabled: record.postEnabled, goalProgressEnabled: record.goalProgressEnabled === true, states: Object.fromEntries(conversationNoticeStates.map(key => [key, states[key] === true])) as ConversationNoticePreferences['states'] }
}

export function conversationNoticeEnabled(preferences: ConversationNoticePreferences, notice: Pick<ConversationNotice, 'state' | 'goalProgress'>): boolean {
  return preferences.states[notice.state] && (!notice.goalProgress || preferences.goalProgressEnabled)
}

export function conversationNoticeLabel(notice: Pick<ConversationNotice, 'state' | 'goalProgress'> & { resumeSource?: AutomaticResumeSource }): string {
  if (notice.state === 'resumeStarted') {
    if (notice.resumeSource === 'quota') return '额度恢复续跑已启动'
    if (notice.resumeSource === 'scheduled') return '定时续跑已启动'
  }
  return notice.goalProgress ? 'GOAL 阶段完成' : conversationNoticeLabels[notice.state]
}

export function conversationNoticeReceipt(notice: ConversationNotice): string {
  return notice.state === 'resumeStarted'
    ? JSON.stringify([notice.threadId, 'resumeStarted', notice.deliveryId])
    : JSON.stringify([notice.threadId, notice.turnId])
}

// Both channels classify the same terminal events and confirmed automatic resumptions.
export function createConversationNoticeClassifier() {
  const retryErrors = new Map<string, 'quota' | 'error'>()
  const goalStatuses = new Map<string, ThreadGoal['status']>()
  return (notification: { method: string; params: unknown }): ConversationNotice | null => {
    if (!['turn/completed', 'turn/cancelled', 'error', 'thread/goal/updated', 'thread/goal/cleared', automaticResumeStartedMethod].includes(notification.method)) return null
    const params = asRecord(notification.params)
    const threadId = extractThreadIdFromNotification({ ...notification, atIso: '' })
    if (!threadId) return null
    if (notification.method === automaticResumeStartedMethod) {
      const deliveryId = readString(params?.deliveryId)
      const source = params?.source
      if (!deliveryId || (source !== 'quota' && source !== 'scheduled')) return null
      return { threadId, turnId: readString(params?.turnId), state: 'resumeStarted', deliveryId, resumeSource: source }
    }
    const goalStatus = notification.method === 'thread/goal/updated' ? asRecord(params?.goal)?.status : params?.goalStatus
    if (typeof goalStatus === 'string' && Object.hasOwn(goalStatusLabels, goalStatus)) {
      goalStatuses.delete(threadId)
      goalStatuses.set(threadId, goalStatus as ThreadGoal['status'])
      if (goalStatuses.size > 2000) goalStatuses.delete(goalStatuses.keys().next().value!)
    } else if (notification.method === 'thread/goal/cleared' || goalStatus === null) {
      goalStatuses.delete(threadId)
    }
    if (notification.method.startsWith('thread/goal/')) return null
    const turn = asRecord(params?.turn)
    const turnId = readString(turn?.id) || readString(params?.turnId)
    if (!threadId || !turnId) return null
    const key = JSON.stringify([threadId, turnId])
    if (params?.interruptionReason === 'user') {
      retryErrors.delete(key)
      return null
    }
    if (notification.method === 'error' && params?.willRetry === true) {
      if (params.error) {
        const kind = isFinalQuotaInterruption({ status: 'failed', error: params.error }) ? 'quota' : 'error'
        // A later retry message must not erase a known quota cause.
        if (retryErrors.get(key) !== 'quota') retryErrors.set(key, kind)
        if (retryErrors.size > 256) retryErrors.delete(retryErrors.keys().next().value!)
      }
      return null
    }
    const earlierError = retryErrors.get(key)
    retryErrors.delete(key)
    const completed = notification.method === 'turn/completed' && turn?.status === 'completed' && !turn.error
    const quota = earlierError === 'quota' || isFinalQuotaInterruption({ status: 'failed', error: turn?.error || params?.error })
    // Native user stops have no error; explicit user intent also overrides a prior quota retry.
    const interruption = classifyThreadInterruption({ status: turn?.status === 'failed' || notification.method === 'error' ? 'failed' : 'interrupted', error: turn?.error || params?.error })
    if (!completed && !quota && !interruption && !earlierError) return null
    const state = completed ? params?.completionKind === 'background' ? 'automation' : 'completed' : quota ? 'quota' : 'interrupted'
    return { threadId, turnId, state, ...(completed && goalStatuses.get(threadId) === 'active' ? { goalProgress: true } : {}) }
  }
}
