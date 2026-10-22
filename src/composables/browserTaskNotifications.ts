import { ref } from 'vue'
import type { RpcNotification } from '../api/codexRpcClient'
import { createConversationNoticeClassifier, conversationNoticeEnabled, conversationNoticeLabel, conversationNoticeReceipt } from '../conversationNotifications'
import { callRpc } from '../api/rpcGateway'
import { getWorkspaceRootsState } from '../api/projectGateway'
import { conversationNotificationProjectName, type ConversationNotificationContext } from '../conversationNotificationContext'
import { conversationNoticePreferences, loadConversationNoticePreferences } from './conversationNoticePreferences'
import { t } from './useUiLanguage'
import { asRecord, readString } from './threadNotificationValues'

const preferenceKey = 'sidux.browser-notifications.enabled.v1'
const receiptKey = 'sidux.browser-notifications.receipts.v1'
function storage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}
function readEnabled(): boolean {
  try { return storage()?.getItem(preferenceKey) !== 'false' } catch { return true }
}
export const browserNotificationsEnabled = ref(readEnabled())
export const browserNotificationPermission = ref<NotificationPermission | 'unsupported'>(
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
)
export async function enableBrowserNotifications(): Promise<void> {
  if (typeof Notification === 'undefined') throw new Error('当前浏览器不支持通知，请使用 HTTPS 或本机 localhost。')
  const permission = await Notification.requestPermission()
  browserNotificationPermission.value = permission
  if (permission !== 'granted') throw new Error('浏览器通知未获授权，请在浏览器的网站设置中允许通知。')
  setBrowserNotificationsEnabled(true)
}
export function setBrowserNotificationsEnabled(enabled: boolean): void {
  storage()?.setItem(preferenceKey, String(enabled))
  browserNotificationsEnabled.value = enabled
}

export function createBrowserTaskNotifications(getContext: (threadId: string) => ConversationNotificationContext | undefined) {
  const seen = new Set<string>()
  const classify = createConversationNoticeClassifier()
  let pendingCount = 0
  let metadataRead: Promise<unknown> = Promise.resolve()
  if (typeof window !== 'undefined' && browserNotificationsEnabled.value && typeof Notification !== 'undefined') {
    void loadConversationNoticePreferences().catch(() => {})
  }
  return (notification: RpcNotification): void => {
    const event = classify(notification)
    if (!event) return
    const { threadId, turnId } = event
    const key = event.state === 'resumeStarted' ? conversationNoticeReceipt(event) : `${threadId}:${turnId}`
    if (!browserNotificationsEnabled.value || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (seen.has(key) || pendingCount >= 256) return
    seen.add(key)
    pendingCount++
    if (seen.size > 256) seen.delete(seen.values().next().value!)
    // Copy both names now so a later rename cannot change a deferred notification.
    const current = getContext(threadId)
    const context = current ? { ...current } : undefined
    const show = async (): Promise<void> => {
      if (typeof window !== 'undefined') {
        try { await loadConversationNoticePreferences() } catch { return }
      }
      if (!browserNotificationsEnabled.value || !conversationNoticeEnabled(conversationNoticePreferences.value, event)) return
      const claimReceipt = (): boolean => {
        let receipts: string[] = []
        try {
          const saved = JSON.parse(storage()?.getItem(receiptKey) || '[]')
          if (Array.isArray(saved)) receipts = saved.filter(row => typeof row === 'string').slice(-256)
          if (receipts.includes(key)) return false
          storage()?.setItem(receiptKey, JSON.stringify([...receipts, key].slice(-256)))
        } catch { /* In-memory receipts still prevent duplicate events in this tab. */ }
        return true
      }
      // Hold the cross-tab lock only for the receipt, never for metadata I/O.
      const claimed = typeof navigator !== 'undefined' && navigator.locks
        ? await navigator.locks.request('sidux-browser-notification', claimReceipt)
        : claimReceipt()
      if (!claimed) return
      let details = context
      if (!details) {
        try {
          const read = metadataRead.then(async () => {
            const result = await callRpc<{ thread: unknown }>('thread/read', { threadId, includeTurns: false })
            const thread = asRecord(result.thread)
            const roots = await getWorkspaceRootsState().catch(() => null)
            return {
              title: readString(thread?.title) || readString(thread?.name) || readString(thread?.preview),
              projectName: conversationNotificationProjectName(readString(thread?.cwd), roots),
            }
          })
          metadataRead = read.catch(() => undefined)
          details = await read
        } catch { /* A removed conversation may no longer have readable metadata. */ }
      }
      if (!browserNotificationsEnabled.value || !conversationNoticeEnabled(conversationNoticePreferences.value, event)) return
      const body = `${details?.projectName || t('无项目')} · ${details?.title || t('Untitled thread')}`
      try {
        const notice = new Notification(t(conversationNoticeLabel(event)), { body, tag: `sidux:${key}` })
        notice.onclick = () => {
          window.focus()
          window.location.hash = `/thread/${encodeURIComponent(threadId)}`
          notice.close()
        }
      } catch { /* Browser policy may reject delivery after a permission change. */ }
    }
    void show().catch(() => {}).finally(() => { pendingCount-- })
  }
}
