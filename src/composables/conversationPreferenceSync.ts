import { getConversationPreferences, persistConversationPreferences } from '../api/threadPreferencesGateway'
import { normalizeConversationPreferences, type ConversationPreferencePatch } from '../conversationPreferences'
import type { useWebConversationPreferences } from '../webConversationPreferences'

// Only changed entries are sent. Importing an old browser cache fills missing entries only.
export const CONVERSATION_PENDING_KEY = 'codexapp.conversation-preference-pending.v1'
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserPendingStorage(): PendingStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage } catch { return undefined }
}

export function createConversationPreferenceSync(preferences: ReturnType<typeof useWebConversationPreferences>, storage = browserPendingStorage()) {
  const initial = preferences.state.value
  let pending: ConversationPreferencePatch | null = initial.defaults || Object.keys(initial.threads).length || !initial.remember
    ? { migrate: initial } : null
  let writing: Promise<boolean> | null = null
  let revision = 0
  let inFlight: ConversationPreferencePatch | null = null

  function merge(left: ConversationPreferencePatch | null, right: ConversationPreferencePatch): ConversationPreferencePatch {
    return { ...left, ...right, threads: { ...left?.threads, ...right.threads } }
  }

  // Per-tab storage survives reload without making another open tab replay this tab's edits.
  try {
    const raw = JSON.parse(storage?.getItem(CONVERSATION_PENDING_KEY) || 'null')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const normalized = normalizeConversationPreferences(raw)
      const restored: ConversationPreferencePatch = {}
      if ('defaults' in raw) restored.defaults = normalized.defaults
      if ('remember' in raw) restored.remember = normalized.remember
      if ('threads' in raw) restored.threads = normalized.threads
      if ('migrate' in raw) restored.migrate = normalizeConversationPreferences(raw.migrate)
      pending = merge(pending, restored)
    }
  } catch { /* Ignore malformed or unavailable tab storage. */ }

  function checkpoint(): void {
    try {
      const outstanding = pending ? merge(inFlight, pending) : inFlight
      if (outstanding) storage?.setItem(CONVERSATION_PENDING_KEY, JSON.stringify(outstanding))
      else storage?.removeItem(CONVERSATION_PENDING_KEY)
    } catch {
      preferences.error.value = '会话设置尚未同步，浏览器也无法保存重试记录，请保持此页面打开后重试。'
    }
  }

  function flush(): Promise<boolean> {
    if (writing) return writing
    writing = Promise.resolve().then(async () => {
      while (pending) {
        const patch = pending
        pending = null
        inFlight = patch
        checkpoint()
        try {
          await persistConversationPreferences(patch)
          inFlight = null
          preferences.error.value = ''
          checkpoint()
        } catch {
          pending = merge(patch, pending || {})
          inFlight = null
          preferences.error.value = '会话设置保存失败，请检查连接后重试。'
          checkpoint()
          return false
        }
      }
      return true
    }).finally(() => { writing = null })
    return writing
  }

  return {
    save(patch: ConversationPreferencePatch): void {
      revision++
      pending = merge(pending, patch)
      checkpoint()
      void flush()
    },
    async refresh(threadId: string, isCurrent: () => boolean): Promise<boolean> {
      if (!await flush()) return false
      const before = revision
      try {
        const remote = await getConversationPreferences(threadId)
        if (!isCurrent() || before !== revision) return false
        const previous = preferences.state.value
        const changed = JSON.stringify(previous.defaults) !== JSON.stringify(remote.defaults)
          || previous.remember !== remote.remember
          || JSON.stringify(previous.threads[threadId]) !== JSON.stringify(remote.threads[threadId])
        // Other cached entries are retained for immediate projection, then revalidated on entry.
        const threads = { ...previous.threads }
        delete threads[threadId]
        preferences.cacheRemote({ ...remote, threads: { ...threads, ...remote.threads } })
        return changed
      } catch {
        if (isCurrent()) preferences.error.value = '会话设置同步失败，请检查连接后重试。'
        return false
      }
    },
    flush,
  }
}
