import { ref } from 'vue'
import { capabilityValue, type ModelCapability } from './modelCapabilities'
export type ConversationChoice = { model: string; provider: string; effort: string; tier: string }
export const WEB_CONVERSATION_PREFERENCES_KEY = 'codexapp.web-conversation-preferences.v1'
type Preferences = { defaults: ConversationChoice | null; remember: boolean; threads: Record<string, { source: 'web'; saved: ConversationChoice }> }
function choice(value: unknown): ConversationChoice | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!capabilityValue(row.model)) return null
  return { model: capabilityValue(row.model), provider: capabilityValue(row.provider), effort: capabilityValue(row.effort), tier: capabilityValue(row.tier) }
}
export function useWebConversationPreferences(storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  let initial: Preferences = { defaults: null, remember: true, threads: {} }
  try {
    const raw = JSON.parse(storage?.getItem(WEB_CONVERSATION_PREFERENCES_KEY) || '{}')
    initial = { defaults: choice(raw.defaults), remember: raw.remember !== false,
      threads: Object.fromEntries(Object.entries(raw.threads || {}).flatMap(([id, value]) => {
        const row = value as { source?: unknown; saved?: unknown }
        const saved = choice(row?.saved)
        return row?.source === 'web' && saved ? [[id, { source: 'web' as const, saved }]] : []
      })) }
  } catch { /* Keep previous application defaults if no valid preferences exist. */ }
  const state = ref(initial)
  const sessions = ref<Record<string, ConversationChoice>>({})
  const error = ref('')
  function persist(next: Preferences): void {
    try {
      storage?.setItem(WEB_CONVERSATION_PREFERENCES_KEY, JSON.stringify(next))
      state.value = next
      error.value = ''
    } catch {
      error.value = '设置保存失败，请检查浏览器存储后重试。'
      throw new Error(error.value)
    }
  }
  function enter(id: string, fallback: ConversationChoice): ConversationChoice | null {
    const known = state.value.threads[id]
    if (id && !known) return null
    const selected = id && state.value.remember && known ? known.saved : state.value.defaults || fallback
    sessions.value = { ...sessions.value, [id]: { ...selected } }
    return sessions.value[id]
  }
  function register(id: string, value: ConversationChoice): void {
    persist({ ...state.value, threads: { ...state.value.threads, [id]: { source: 'web', saved: { ...value } } } })
    sessions.value = { ...sessions.value, [id]: { ...value } }
  }
  function select(id: string, value: ConversationChoice): void {
    if (id && !state.value.threads[id]) return
    if (id && state.value.remember) persist({ ...state.value, threads: { ...state.value.threads, [id]: { source: 'web', saved: { ...value } } } })
    sessions.value = { ...sessions.value, [id]: { ...value } }
  }
  return { state, sessions, error, enter, register, select,
    configure(defaults: ConversationChoice, remember: boolean): void { persist({ ...state.value, defaults, remember }) },
  }
}

// Saved intent is immutable during catalog changes. Only the effective choice falls back.
export function effectiveConversationChoice(saved: ConversationChoice, models: ModelCapability[]): ConversationChoice {
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
