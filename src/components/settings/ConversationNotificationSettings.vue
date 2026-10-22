<template>
  <section class="notification-settings settings-integration-card conversation-notification-settings">
    <h3>{{ t('会话状态通知') }}</h3>
    <div class="conversation-notification-options">
      <div class="conversation-notification-channels">
        <AppSwitch :model-value="browserNotificationsEnabled" :disabled="busy" @update:model-value="toggleBrowser">{{ t('浏览器通知') }}</AppSwitch>
        <AppButton v-if="browserNotificationsEnabled && browserNotificationPermission !== 'granted'" :busy="busy" @click="enable">{{ t('允许浏览器通知') }}</AppButton>
        <AppSwitch :model-value="conversationNoticePreferences.postEnabled" :disabled="busy || !loaded" @update:model-value="togglePost">{{ t('POST通知') }}</AppSwitch>
        <div class="conversation-notification-goal">
          <AppSwitch :model-value="conversationNoticePreferences.goalProgressEnabled" :disabled="busy || !loaded" @update:model-value="toggleGoalProgress">{{ t('GOAL阶段性通知') }}</AppSwitch>
        </div>
      </div>
      <div class="conversation-notification-states">
        <AppSwitch v-for="option in stateOptions" :key="option.value" :model-value="conversationNoticePreferences.states[option.value]" :disabled="busy || !loaded" @update:model-value="toggleState(option.value, $event)">{{ t(option.label) }}</AppSwitch>
      </div>
    </div>
    <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppSwitch from '../common/AppSwitch.vue'
import { t } from '../../composables/useUiLanguage'
import { browserNotificationsEnabled, browserNotificationPermission, enableBrowserNotifications, setBrowserNotificationsEnabled } from '../../composables/browserTaskNotifications'
import { conversationNoticePreferences, loadConversationNoticePreferences, saveConversationNoticePreferences } from '../../composables/conversationNoticePreferences'
import type { ConversationNoticePreferences, ConversationNoticeState } from '../../conversationNotifications'

const stateOptions: { value: ConversationNoticeState; label: string }[] = [
  { value: 'completed', label: '会话完成' },
  { value: 'quota', label: '额度受限' },
  { value: 'interrupted', label: '意外中断' },
  { value: 'automation', label: '自动化任务' },
  { value: 'resumeStarted', label: '自动续跑启动' },
]
const busy = ref(false)
const loaded = ref(false)
const error = ref('')
onMounted(async () => {
  try {
    await loadConversationNoticePreferences()
    loaded.value = true
  } catch {
    error.value = '读取通知设置失败。'
  }
})
async function enable(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await enableBrowserNotifications()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
async function toggleBrowser(enabled: boolean): Promise<void> {
  if (enabled) {
    await enable()
    return
  }
  try {
    setBrowserNotificationsEnabled(false)
    error.value = ''
  } catch {
    error.value = '设置保存失败，请检查浏览器存储后重试。'
  }
}
async function save(value: ConversationNoticePreferences): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await saveConversationNoticePreferences(value)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
function togglePost(enabled: boolean): Promise<void> {
  return save({ ...conversationNoticePreferences.value, postEnabled: enabled })
}
function toggleGoalProgress(enabled: boolean): Promise<void> {
  return save({ ...conversationNoticePreferences.value, goalProgressEnabled: enabled })
}
function toggleState(state: ConversationNoticeState, enabled: boolean): Promise<void> {
  const value = conversationNoticePreferences.value
  return save({ ...value, states: { ...value.states, [state]: enabled } })
}
</script>
