<template>
  <section class="notification-settings settings-integration-card">
    <h3>Telegram</h3>
    <AppSwitch v-model="configuration.notificationsEnabled" :disabled="isSaving">{{ t('启用Telegram通知') }}</AppSwitch>
    <label>{{ t('Bot token') }}<input v-model="configuration.botToken" class="app-input" type="password" placeholder="123456:ABCDEF" autocomplete="off" spellcheck="false" :disabled="isSaving" /></label>
    <div class="notification-message-field"><label>{{ t('Allowed Telegram user IDs') }}<textarea v-model="allowedUserIds" class="app-input" rows="5" placeholder="123456789&#10;987654321&#10;*" spellcheck="false" :disabled="isSaving" /></label></div>
    <div class="notification-actions">
      <p v-if="error" class="account-panel-error" role="alert">{{ error }}</p>
      <AppButton :variant="hasChanges ? 'primary' : 'default'" :busy="isSaving" @click="save()">{{ t('保存配置') }}</AppButton>
      <AppButton :disabled="isSaving || !configuration.notificationsEnabled" @click="test">{{ t('发送测试通知') }}</AppButton>
    </div>
    <div class="notification-quiet">
      <AppSwitch v-model="quiet.quietEnabled" :disabled="isSaving" @change="saveQuietHours">{{ t('免打扰') }}</AppSwitch>
      <div class="notification-hours">
        <AppTimeInput v-model="quiet.quietStart" class="app-input" :aria-label="t('免打扰开始')" placeholder="22:00" :disabled="isSaving || !quiet.quietEnabled" @change="saveQuietHours" />
        <span>{{ t('至') }}</span>
        <AppTimeInput v-model="quiet.quietEnd" class="app-input" :aria-label="t('免打扰结束')" placeholder="08:00" :disabled="isSaving || !quiet.quietEnabled" @change="saveQuietHours" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppSwitch from '../common/AppSwitch.vue'
import AppTimeInput from '../common/AppTimeInput.vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import { notifyOperation } from '../../composables/useOperationToast'
import { displayTimeZone } from '../../dateTime'
import {
  configureTelegramBot,
  getTelegramConfig,
  getTelegramStatus,
  type TelegramConfig,
  type TelegramStatus,
} from '../../api/telegramGateway'

const { t, uiLanguage } = useUiLanguage()
const configuration = ref<Pick<TelegramConfig, 'botToken' | 'notificationsEnabled'>>({ botToken: '', notificationsEnabled: false })
const quiet = ref<Pick<TelegramConfig, 'quietEnabled' | 'quietStart' | 'quietEnd'>>({ quietEnabled: false, quietStart: '22:00', quietEnd: '08:00' })
const allowedUserIds = ref('')
const error = ref('')
const isSaving = ref(false)
const savedSnapshot = ref('')
const hasChanges = computed(() => savedSnapshot.value !== snapshot())
const status = ref<TelegramStatus>({
  configured: false,
  active: false,
  mappedChats: 0,
  mappedThreads: 0,
  allowedUsers: 0,
  allowAllUsers: false,
  lastError: '',
})

function normalizedAllowedUserIds(value: string): Array<number | '*'> {
  const entries = value.split(/[\n,]/).map(entry => entry.trim().replace(/^(telegram|tg):/i, '').trim()).filter(Boolean)
  const allowAllUsers = entries.includes('*')
  const ids = [...new Set(entries.filter(entry => /^-?\d+$/.test(entry)).map(entry => Number.parseInt(entry, 10)))]
  return allowAllUsers ? ['*', ...ids] : ids
}

function snapshot(): string {
  return JSON.stringify({
    botToken: configuration.value.botToken.trim(),
    notificationsEnabled: configuration.value.notificationsEnabled,
    quiet: quiet.value,
    allowedUserIds: normalizedAllowedUserIds(allowedUserIds.value),
  })
}

function applyConfig(config: TelegramConfig): void {
  configuration.value = { botToken: config.botToken, notificationsEnabled: config.notificationsEnabled }
  quiet.value = { quietEnabled: config.quietEnabled, quietStart: config.quietStart, quietEnd: config.quietEnd }
  allowedUserIds.value = config.allowedUserIds.map(value => String(value)).join('\n')
  savedSnapshot.value = snapshot()
  error.value = ''
}

async function refreshConfig(): Promise<void> {
  try {
    applyConfig(await getTelegramConfig())
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Failed to load Telegram configuration'
  }
}

async function refreshStatus(): Promise<void> {
  try {
    status.value = await getTelegramStatus()
  } catch (cause) {
    status.value = {
      configured: false,
      active: false,
      mappedChats: 0,
      mappedThreads: 0,
      allowedUsers: 0,
      allowAllUsers: false,
      lastError: cause instanceof Error ? cause.message : 'Failed to load Telegram status',
    }
  }
}

async function save(showNotice = true): Promise<boolean> {
  if (isSaving.value) return false
  const botToken = configuration.value.botToken.trim()
  const ids = normalizedAllowedUserIds(allowedUserIds.value)
  if (!botToken) {
    error.value = t('Telegram bot token is required.')
    return false
  }
  if (!ids.length) {
    error.value = t('At least one allowed Telegram user ID or * is required.')
    return false
  }
  isSaving.value = true
  error.value = ''
  try {
    await configureTelegramBot(botToken, ids, configuration.value.notificationsEnabled, { ...quiet.value, timezone: displayTimeZone() })
    allowedUserIds.value = ids.map(value => String(value)).join('\n')
    await Promise.all([refreshConfig(), refreshStatus()])
    if (showNotice) notifyOperation('已保存', 'success')
    return true
  } catch (cause) {
    notifyOperation(cause instanceof Error ? cause.message : t('Failed to connect Telegram bot'))
    void refreshStatus()
    return false
  } finally {
    isSaving.value = false
  }
}

async function saveQuietHours(): Promise<void> {
  if (isSaving.value) return
  isSaving.value = true
  error.value = ''
  try {
    const response = await fetch('/codex-api/telegram/notification-preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...quiet.value, timezone: displayTimeZone() }),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '保存失败')
  } catch (cause) {
    notifyOperation(cause instanceof Error ? cause.message : '保存失败')
  } finally {
    isSaving.value = false
  }
}

async function test(): Promise<void> {
  if (!configuration.value.notificationsEnabled || !await save(false)) return
  isSaving.value = true
  error.value = ''
  try {
    const response = await fetch('/codex-api/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: uiLanguage.value }),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '测试通知发送失败。')
    notifyOperation('通知已发送', 'success')
  } catch (cause) {
    notifyOperation(cause instanceof Error ? cause.message : '测试通知发送失败。')
  } finally {
    isSaving.value = false
  }
}

void refreshConfig()
void refreshStatus()
</script>
