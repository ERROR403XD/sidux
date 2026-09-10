<template>
  <div class="notification-settings">
    <h3>{{ t('信息通知') }}</h3>
    <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <template v-if="loaded">
      <label class="notification-check"><input v-model="settings.enabled" type="checkbox" :disabled="busy" />{{ t('启用POST通知') }}</label>
      <label>{{ t('请求地址') }}<input v-model="settings.url" class="app-input" type="url" placeholder="https://…" :disabled="busy" /></label>
      <label>{{ t('JSON请求体') }}<textarea v-model="settings.body" class="app-input" rows="6" spellcheck="false" :disabled="busy" /></label>
      <small v-text="t('用 {{message}} 插入通知正文。')"></small>
      <label class="notification-check"><input v-model="settings.quietEnabled" type="checkbox" :disabled="busy" />{{ t('免打扰') }}</label>
      <div v-if="settings.quietEnabled" class="notification-hours"><input v-model="settings.quietStart" class="app-input" :aria-label="t('免打扰开始')" placeholder="22:00" maxlength="5" :disabled="busy" /><span>{{ t('至') }}</span><input v-model="settings.quietEnd" class="app-input" :aria-label="t('免打扰结束')" placeholder="08:00" maxlength="5" :disabled="busy" /></div>
      <small v-if="settings.quietEnabled">{{ t('期间暂存，结束后发送；使用全局时区。') }}</small>
      <div class="notification-actions">
        <AppButton :busy="busy" @click="save()">{{ t('保存通知设置') }}</AppButton>
        <AppButton :disabled="busy || !settings.enabled" @click="test">{{ t('发送测试通知') }}</AppButton>
        <span v-if="notice" role="status">{{ t(notice) }}</span>
      </div>
    </template>
  </div>
</template>
<script setup lang="ts">
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
