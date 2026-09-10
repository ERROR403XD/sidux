<template>
  <section class="notification-settings settings-integration-card">
    <h3>POST</h3>
    <template v-if="loaded">
      <AppSwitch v-model="settings.enabled" :disabled="busy">{{ t('启用POST通知') }}</AppSwitch>
      <label>{{ t('请求地址') }}<input v-model="settings.url" class="app-input" type="url" placeholder="https://…" :disabled="busy" /></label>
      <div class="notification-message-field"><label>{{ t('JSON请求体') }}<textarea v-model="settings.body" class="app-input" rows="5" spellcheck="false" :disabled="busy" /></label><small v-text="t('用 {{message}} 插入通知正文。')"></small></div>
      <div class="notification-actions">
        <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
        <AppButton :busy="busy" @click="save()">{{ t('保存POST设置') }}</AppButton>
        <AppButton :disabled="busy || !settings.enabled" @click="test">{{ t('发送测试通知') }}</AppButton>
        <span v-if="notice" role="status">{{ t(notice) }}</span>
      </div>
      <div class="notification-quiet">
        <AppSwitch v-model="settings.quietEnabled" :disabled="busy" @change="save()">{{ t('免打扰') }}</AppSwitch>
        <div class="notification-hours">
          <input v-model="settings.quietStart" class="app-input" :aria-label="t('免打扰开始')" placeholder="22:00" maxlength="5" :disabled="busy || !settings.quietEnabled" @change="save()" />
          <span>{{ t('至') }}</span>
          <input v-model="settings.quietEnd" class="app-input" :aria-label="t('免打扰结束')" placeholder="08:00" maxlength="5" :disabled="busy || !settings.quietEnabled" @change="save()" />
        </div>
      </div>
    </template>
    <p v-if="error && !loaded" class="account-panel-error" role="alert">{{ t(error) }}</p>
  </section>
</template>
<script setup lang="ts">
import AppSwitch from '../common/AppSwitch.vue'
import { t } from '../../composables/useUiLanguage'

import { onMounted, ref } from 'vue'
import { useTransientNotice } from '../../composables/useTransientNotice'
import AppButton from '../common/AppButton.vue'
import { defaultNotificationSettings, validateNotificationSettings, type NotificationSettings } from '../../accountNotifications'
import { displayTimeZone } from '../../dateTime'
import { apiProxyRequest } from '../../api/apiProxy'
const settings = ref<NotificationSettings>({ ...defaultNotificationSettings })
const loaded = ref(false)
const busy = ref(false)
const notice = useTransientNotice()
const error = ref('')
onMounted(async () => {
  try {
    const result = await apiProxyRequest<{ settings: NotificationSettings; lastResult: string | null }>('/notifications')
    settings.value = { ...result.settings, timezone: displayTimeZone() }
    loaded.value = true
  } catch { error.value = '读取通知设置失败。' }
})
async function save(showNotice = true): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  notice.value = ''
  error.value = ''
  try {
    const value = validateNotificationSettings({ ...settings.value, timezone: displayTimeZone() })
    await apiProxyRequest('/notifications', { settings: value })
    if (showNotice) notice.value = '已保存'
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存通知设置失败。'
    return false
  } finally {
    busy.value = false
  }
}
async function test(): Promise<void> {
  if (!await save(false)) return
  busy.value = true
  try {
    const result = await apiProxyRequest<{ lastResult: string }>('/notifications/test', {})
    if (result.lastResult === '测试通知已发送') notice.value = '通知已发送'
    else error.value = result.lastResult || '测试发送结果未确认'
  } catch {
    error.value = '测试通知发送失败。'
  } finally {
    busy.value = false
  }
}
</script>
