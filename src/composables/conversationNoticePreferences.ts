import { ref } from 'vue'
import { apiProxyRequest } from '../api/apiProxy'
import { defaultConversationNoticePreferences, validateConversationNoticePreferences, type ConversationNoticePreferences } from '../conversationNotifications'

export const conversationNoticePreferences = ref(defaultConversationNoticePreferences())
let loadFlight: Promise<void> | undefined
let loaded = false

export function loadConversationNoticePreferences(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (loadFlight) return loadFlight
  loadFlight = apiProxyRequest<ConversationNoticePreferences>('/notifications/conversations').then(value => {
    conversationNoticePreferences.value = validateConversationNoticePreferences(value)
    loaded = true
  }).finally(() => { loadFlight = undefined })
  return loadFlight
}

export async function saveConversationNoticePreferences(value: ConversationNoticePreferences): Promise<void> {
  conversationNoticePreferences.value = await apiProxyRequest<ConversationNoticePreferences>('/notifications/conversations', validateConversationNoticePreferences(value))
  loaded = true
}
