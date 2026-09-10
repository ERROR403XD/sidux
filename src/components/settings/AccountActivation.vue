<template>
  <section class="account-activation">
    <div class="account-panel-header"><h3>{{ t('定时激活') }}</h3><span v-if="saving" class="account-card-meta" role="status">{{ t('保存中…') }}</span></div>
    <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <div v-if="snapshot" class="activation-layout">
      <div class="activation-selection">
        <AppSwitch v-model="settings.enabled">{{ t('启用账号定时激活') }}</AppSwitch>
        <div class="activation-account-list">
          <span class="activation-section-label">{{ t('生效账号') }}</span>
          <AppSwitch v-for="account in accounts" :key="account.storageId" :model-value="settings.accountIds.includes(account.storageId)" @change="toggleAccount(account.storageId, $event)">{{ accountDisplayName(account) }}</AppSwitch>
          <p v-if="!accounts.length" class="account-card-meta">{{ t('请先添加 GPT 账号。') }}</p>
        </div>
      </div>
      <div class="activation-schedule">
        <div class="activation-times-heading"><span class="activation-section-label">{{ t('每日激活时间') }}</span><AppButton :disabled="settings.times.length >= 24" @click="addTime">{{ t('添加时间') }}</AppButton></div>
        <div class="activation-time-list">
          <p v-if="!settings.times.length" class="account-card-meta">{{ t('尚未添加时间') }}</p>
          <div v-for="(_, index) in settings.times" :key="index" class="activation-time-row">
            <input :value="settings.times[index]?.split(':')[0]" class="app-input activation-time-part" type="text" inputmode="numeric" maxlength="2" :aria-label="t(`激活小时 ${index + 1}`)" placeholder="HH" @input="setTimePart(index, 0, $event)" @blur="normalizeTime(index)" /><span>:</span>
            <input :value="settings.times[index]?.split(':')[1]" class="app-input activation-time-part" type="text" inputmode="numeric" maxlength="2" :aria-label="t(`激活分钟 ${index + 1}`)" placeholder="mm" @input="setTimePart(index, 1, $event)" @blur="normalizeTime(index)" />
            <AppButton @click="settings.times.splice(index, 1)">{{ t('移除') }}</AppButton>
          </div>
        </div>
      </div>
      <p class="activation-next account-card-meta">{{ t('下次计划：') }}{{ snapshot.nextAt ? formatLocalDateTime(snapshot.nextAt) : t('未安排') }}</p>
    </div>
    <div v-if="recent.length" class="activation-results"><div v-for="run in recent" :key="run.key"><strong>{{ accountName(run.accountId) }}</strong><span>{{ run.finishedAt ? formatLocalDateTime(run.finishedAt) : t('准备中') }} · {{ t(labels[run.status]) }}</span><small>{{ t(run.reason) }}</small></div></div>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { accountDisplayName } from '../../accountDisplay'
import AppButton from '../common/AppButton.vue'
import AppSwitch from '../common/AppSwitch.vue'
import type { UiAccountEntry } from '../../types/codex'
import { formatLocalDateTime, displayTimeZone } from '../../dateTime'
import { validateActivationSettings, type ActivationSettings, type ActivationSnapshot } from '../../accountActivation'
const props = defineProps<{ accounts: UiAccountEntry[] }>()
const snapshot = ref<ActivationSnapshot | null>(null)
const settings = ref<ActivationSettings>({ enabled: false, accountIds: [], times: [], timezone: displayTimeZone() })
const error = ref('')
const saving = ref(false)
const recent = computed(() => snapshot.value?.runs.filter((run, index, rows) => rows.findIndex(row => row.accountId === run.accountId) === index) || [])
const labels = { preparing: '准备中', sending: '激活中', sent: '已完成', skipped: '已跳过', unknown: '结果未确认' }
let loaded = false
let disposed = false
let revision = 0
let timer: ReturnType<typeof setTimeout> | undefined
let poll: ReturnType<typeof setInterval> | undefined
let lastSaved = ''
function toggleAccount(id: string, enabled: boolean): void {
  settings.value.accountIds = enabled ? [...settings.value.accountIds, id] : settings.value.accountIds.filter(value => value !== id)
}
function addTime(): void {
  for (let hour = 8; hour < 32; hour++) {
    const time = `${String(hour % 24).padStart(2, '0')}:00`
    if (!settings.value.times.includes(time)) {
      settings.value.times.push(time)
      return
    }
  }
}
function setTimePart(index: number, part: number, event: Event): void {
  const input = event.target as HTMLInputElement
  const pieces = (settings.value.times[index] || ':').split(':')
  pieces[part] = input.value.replace(/\D/g, '').slice(0, 2)
  input.value = pieces[part]!
  settings.value.times[index] = pieces.join(':')
}
function normalizeTime(index: number): void {
  const value = settings.value.times[index]
  if (value && /^\d{1,2}:\d{1,2}$/.test(value)) settings.value.times[index] = value.split(':').map(part => part.padStart(2, '0')).join(':')
}
function accountName(id: string): string {
  const account = props.accounts.find(row => row.storageId === id)
  return account ? accountDisplayName(account) : t('已移除的账号')
}
async function request(init?: RequestInit): Promise<ActivationSnapshot> {
  const response = await fetch('/codex-api/api-proxy/activation', init)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || '激活设置暂不可用')
  return payload.data
}
async function load(): Promise<void> {
  const before = revision
  try {
    const next = await request()
    if (disposed || before !== revision || saving.value) return
    if (!loaded) {
      settings.value = { ...next.settings, timezone: displayTimeZone() }
      lastSaved = JSON.stringify(next.settings)
      loaded = true
    }
    snapshot.value = next
    error.value = next.error
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败' }
}
async function save(): Promise<void> {
  if (!loaded || saving.value) return
  let value: ActivationSettings
  try {
    value = validateActivationSettings({ ...settings.value, timezone: displayTimeZone(), times: settings.value.times.map(time => /^\d{1,2}:\d{1,2}$/.test(time) ? time.split(':').map(part => part.padStart(2, '0')).join(':') : time) })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '时间格式应为 HH:mm'
    return
  }
  const serialized = JSON.stringify(value)
  if (serialized === lastSaved) return
  const before = revision
  saving.value = true
  error.value = ''
  try {
    const next = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialized, keepalive: true })
    lastSaved = serialized
    if (before === revision) snapshot.value = next
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally {
    saving.value = false
    if (before !== revision) void save()
  }
}
watch(settings, () => {
  if (!loaded) return
  revision++
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { void save() }, 400)
}, { deep: true })
onMounted(() => {
  void load()
  poll = setInterval(() => { if (!document.hidden) void load() }, 30000)
})
onBeforeUnmount(() => {
  disposed = true
  if (timer) clearTimeout(timer)
  if (poll) clearInterval(poll)
  void save()
})
</script>
