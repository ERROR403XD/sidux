<template>
  <div class="notification-settings">
    <h3>信息通知</h3>
    <p v-if="error" class="account-panel-error" role="alert">{{ error }}</p>
    <template v-if="loaded">
      <label class="notification-check"><input v-model="settings.enabled" type="checkbox" :disabled="busy" />启用POST通知</label>
      <label>请求地址<input v-model="settings.url" class="app-input" type="url" placeholder="https://…" :disabled="busy" /></label>
      <label>JSON请求体<textarea v-model="settings.body" class="app-input" rows="6" spellcheck="false" :disabled="busy" /></label>
      <small v-pre>用 {{message}} 放置通知正文；其他字段填写通知服务要求的配置。</small>
      <label class="notification-check"><input v-model="settings.quietEnabled" type="checkbox" :disabled="busy" />免打扰</label>
      <div v-if="settings.quietEnabled" class="notification-hours"><input v-model="settings.quietStart" class="app-input" aria-label="免打扰开始" placeholder="22:00" maxlength="5" :disabled="busy" /><span>至</span><input v-model="settings.quietEnd" class="app-input" aria-label="免打扰结束" placeholder="08:00" maxlength="5" :disabled="busy" /></div>
      <small v-if="settings.quietEnabled">期间暂存，结束后发送；使用全局时区。</small>
      <div><AppButton :busy="busy" @click="save">保存通知设置</AppButton><span v-if="saved" role="status"> 已保存</span></div>
      <small v-if="lastResult">{{ lastResult }}</small>
    </template>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import { defaultNotificationSettings, validateNotificationSettings, type NotificationSettings } from '../../accountNotifications'
import { displayTimeZone } from '../../dateTime'
import { apiProxyRequest } from '../../api/apiProxy'
const settings = ref<NotificationSettings>({ ...defaultNotificationSettings })
const loaded = ref(false)
const busy = ref(false)
const saved = ref(false)
const error = ref('')
const lastResult = ref<string | null>(null)
onMounted(async () => {
  try {
    const result = await apiProxyRequest<{ settings: NotificationSettings; lastResult: string | null }>('/notifications')
    settings.value = { ...result.settings, timezone: displayTimeZone() }
    lastResult.value = result.lastResult
    loaded.value = true
  } catch { error.value = '读取通知设置失败。' }
})
async function save(): Promise<void> {
  if (busy.value) return
  busy.value = true
  saved.value = false
  error.value = ''
  try {
    const value = validateNotificationSettings({ ...settings.value, timezone: displayTimeZone() })
    await apiProxyRequest('/notifications', { settings: value })
    saved.value = true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存通知设置失败。' }
  finally { busy.value = false }
}
</script>
