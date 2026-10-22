import { ref } from 'vue'
import { type ModelCapability } from './modelCapabilities'
import { normalizeConversationPreferences, type ConversationChoice, type ConversationPreferences, type ConversationPreferencePatch } from './conversationPreferences'
export type { ConversationChoice } from './conversationPreferences'
export const WEB_CONVERSATION_PREFERENCES_KEY = 'codexapp.web-conversation-preferences.v1'
export function useWebConversationPreferences(storage?: Pick<Storage, 'getItem' | 'setItem'>, onSave?: (patch: ConversationPreferencePatch) => void) {
  let initial: ConversationPreferences = { defaults: null, remember: true, threads: {} }
  try {
    const raw = JSON.parse(storage?.getItem(WEB_CONVERSATION_PREFERENCES_KEY) || '{}')
    initial = normalizeConversationPreferences(raw)
  } catch { /* Keep previous application defaults if no valid preferences exist. */ }
  const state = ref(initial)
  const sessions = ref<Record<string, ConversationChoice>>({})
  const error = ref('')
  function persist(next: ConversationPreferences, patch: ConversationPreferencePatch): void {
    try {
      storage?.setItem(WEB_CONVERSATION_PREFERENCES_KEY, JSON.stringify(next))
      state.value = next
      error.value = ''
    } catch {
      error.value = '设置保存失败，请检查浏览器存储后重试。'
      throw new Error(error.value)
    }
    onSave?.(patch)
  }
  function enter(id: string, fallback: ConversationChoice): ConversationChoice | null {
    const known = state.value.threads[id]
    if (id && !known) return null
    const selected = id && state.value.remember && known ? known.saved : state.value.defaults || fallback
    sessions.value = { ...sessions.value, [id]: { ...selected } }
    return sessions.value[id]
  }
  function register(id: string, value: ConversationChoice): void {
    const threads = { [id]: { source: 'web' as const, saved: { ...value } } }
    persist({ ...state.value, threads: { ...state.value.threads, ...threads } }, { threads })
    sessions.value = { ...sessions.value, [id]: { ...value } }
  }
  function select(id: string, value: ConversationChoice): void {
    if (id && !state.value.threads[id]) return
    if (id && state.value.remember) {
      const threads = { [id]: { source: 'web' as const, saved: { ...value } } }
      persist({ ...state.value, threads: { ...state.value.threads, ...threads } }, { threads })
    }
    sessions.value = { ...sessions.value, [id]: { ...value } }
  }
  // The running app-server serves one source at a time, so a conversation the runtime binds to the
  // active connection has to keep using it even when the saved choice names another source. Only the
  // effective session moves; the saved choice stays untouched as the user's own intent.
  function bindSource(id: string, provider: string): void {
    const current = sessions.value[id]
    if (!current || !provider || current.provider === provider) return
    sessions.value = { ...sessions.value, [id]: { ...current, provider } }
  }
  return { state, sessions, error, enter, register, select, bindSource,
    cacheRemote(next: ConversationPreferences): void {
      // A read updates the offline cache without creating a write-back loop.
      try {
        storage?.setItem(WEB_CONVERSATION_PREFERENCES_KEY, JSON.stringify(next))
        error.value = ''
      } catch {
        error.value = '会话设置已同步，但浏览器缓存保存失败。'
      }
      state.value = next
    },
    configure(defaults: ConversationChoice, remember: boolean): void { persist({ ...state.value, defaults, remember }, { defaults, remember }) },
  }
}

// Saved intent is immutable during catalog changes. Only the effective choice falls back.
export function effectiveConversationChoice(saved: ConversationChoice, models: readonly ModelCapability[]): ConversationChoice {
  if (!models.length) return { ...saved }
  const order = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']
  const index = order.indexOf(saved.model)
  const model = models.find(row => row.id === saved.model)
    || (index >= 0 ? order.slice(index + 1).map(id => models.find(row => row.id === id)).find(Boolean) : undefined)
    || models[0]!
  const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  let effort = saved.effort
  if (effort && model.efforts && !model.efforts.some(row => row.value === effort)) {
    const rank = efforts.indexOf(effort)
    effort = efforts.slice(0, rank < 0 ? 0 : rank).reverse().find(value => model.efforts!.some(row => row.value === value)) || model.defaultEffort || ''
  }
  const requestedTier = saved.tier === 'fast' ? 'priority' : saved.tier
  const tier = requestedTier && model.serviceTiers && !model.serviceTiers.some(row => row.value === requestedTier) ? '' : requestedTier
  return { ...saved, model: model.id, effort, tier }
}
