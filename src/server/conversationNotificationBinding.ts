import type { AccountNotificationService } from './accountNotificationService.js'
import type { ConversationNotificationContext } from '../conversationNotificationContext.js'
import { automaticResumeStartedMethod } from '../threadAutomaticResume.js'

type ConversationNotificationSource = {
  subscribeNotifications: (listener: (notification: { method: string; params: unknown }) => void) => () => void
  readConversationNotificationContext: (threadId: string) => Promise<ConversationNotificationContext>
}

export function bindConversationNotifications(source: ConversationNotificationSource, service: AccountNotificationService): () => Promise<void> {
  const pending = new Set<Promise<void>>()
  const unsubscribe = source.subscribeNotifications(notification => {
    if (!['turn/completed', 'turn/cancelled', 'error', 'thread/goal/updated', 'thread/goal/cleared', automaticResumeStartedMethod].includes(notification.method)) return
    const work = service.observeConversation(notification, source.readConversationNotificationContext)
    pending.add(work)
    void work.catch(() => console.error('Failed to queue conversation notification')).finally(() => pending.delete(work))
  })
  return async () => {
    unsubscribe()
    await Promise.allSettled([...pending])
  }
}
