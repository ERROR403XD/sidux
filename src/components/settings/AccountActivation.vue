<template>
  <section class="account-activation">
    <div class="account-panel-header"><h3>{{ t('定时激活') }}</h3><span v-if="saving" class="account-card-meta" role="status">{{ t('保存中…') }}</span></div>
    <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <AppSwitch v-if="snapshot" v-model="settings.enabled" class="activation-enabled">{{ t('启用账号定时激活') }}</AppSwitch>
    <div v-if="snapshot" class="activation-layout">
      <div class="activation-selection">
        <div class="activation-times-heading"><span class="activation-section-label">{{ t('生效账号') }}</span></div>
        <div class="activation-account-list">
          <AppSwitch v-for="account in accounts" :key="account.storageId" :model-value="settings.accountIds.includes(account.storageId)" @change="toggleAccount(account.storageId, $event)">{{ accountDisplayName(account) }}</AppSwitch>
          <p v-if="!accounts.length" class="account-card-meta">{{ t('请先添加 GPT 账号。') }}</p>
        </div>
      </div>
      <div class="activation-schedule">
        <div class="activation-times-heading"><span class="activation-section-label">{{ t('每日激活时间') }}</span><AppButton :disabled="settings.times.length >= 24" @click="addTime">{{ t('添加时间') }}</AppButton></div>
        <div class="activation-time-list">
          <p v-if="!settings.times.length" class="account-card-meta">{{ t('尚未添加时间') }}</p>
          <div v-for="(_, index) in settings.times" :key="index" class="activation-time-row">
            <AppTimeInput :model-value="settings.times[index] || ''" :aria-label="t('每日激活时间') + ` ${index + 1}`" @update:model-value="settings.times[index] = $event" />
            <AppButton @click="settings.times.splice(index, 1)">{{ t('移除') }}</AppButton>
          </div>
        </div>
      </div>
      <div class="activation-footer"><p class="account-card-meta">{{ t('下次计划：') }}{{ snapshot.nextAt ? formatLocalDateTime(snapshot.nextAt) : t('未安排') }}</p><AppButton @click="openHistory">{{ t('激活记录') }}</AppButton></div>
    </div>
    <AppDialog :open="historyOpen" :title="t('激活记录')" panel-class="activation-history-dialog" @close="historyOpen = false">
      <p v-if="historyError" class="account-panel-error" role="alert">{{ t(historyError) }}</p>
      <p v-if="historyLoading" class="account-card-meta" role="status">{{ t('读取中…') }}</p>
      <template v-else-if="history?.slots.length">
        <div class="activation-history-heading"><h3>{{ historyTime(history.slots[history.page - 1]!.scheduledAt) }}</h3><span class="account-card-meta">{{ history.runs.length }} {{ t('个账号') }}</span></div>
        <div class="activation-history-list">
          <article v-for="run in history.runs" :key="run.key" class="activation-history-row">
            <div><strong>{{ accountName(run.accountId) }}</strong><span class="activation-history-status" :data-status="run.status">{{ t(labels[run.status]) }}</span></div>
            <p v-if="run.reason && run.status !== 'sent'">{{ t(run.reason) }}</p>
          </article>
        </div>
      </template>
      <p v-else-if="!historyError" class="account-card-meta">{{ t('暂无激活记录') }}</p>
      <template v-if="history?.slots.length" #footer>
        <div class="activation-history-pagination">
          <AppButton :disabled="historyLoading || history.page <= 1" @click="loadHistory(history.page - 1)">{{ t('上一页') }}</AppButton>
          <AppSelect :model-value="String(history.page)" :options="historyOptions" :aria-label="t('选择激活时间')" :disabled="historyLoading" enable-search @update:model-value="loadHistory(Number($event))" />
          <AppButton :disabled="historyLoading || history.page >= history.slots.length" @click="loadHistory(history.page + 1)">{{ t('下一页') }}</AppButton>
        </div>
      </template>
    </AppDialog>
  </section>
</template>
<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { accountDisplayName } from '../../accountDisplay'
import AppButton from '../common/AppButton.vue'
import AppTimeInput from '../common/AppTimeInput.vue'
import AppSwitch from '../common/AppSwitch.vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import type { UiAccountEntry } from '../../types/codex'
import { formatLocalDateTime, displayTimeZone } from '../../dateTime'
import { validateActivationSettings, type ActivationSettings, type ActivationSnapshot, type ActivationHistoryPage } from '../../accountActivation'
const props = defineProps<{ accounts: UiAccountEntry[] }>()
const snapshot = ref<ActivationSnapshot | null>(null)
const settings = ref<ActivationSettings>({ enabled: false, accountIds: [], times: [], timezone: displayTimeZone() })
const error = ref('')
const saving = ref(false)
const historyOpen = ref(false)
const historyLoading = ref(false)
const historyError = ref('')
const history = ref<ActivationHistoryPage | null>(null)
const historyOptions = computed(() => history.value?.slots.map((slot, index) => ({ value: String(index + 1), label: historyTime(slot.scheduledAt) })) || [])
let historyRequest = 0
const labels = { preparing: '准备中', sending: '激活中', sent: '已完成', skipped: '已跳过', unknown: '结果未确认' }
let loaded = false
let disposed = false
let revision = 0
let timer: ReturnType<typeof setTimeout> | undefined
let poll: ReturnType<typeof setInterval> | undefined
let lastSaved = ''
function historyTime(at: number): string { return formatLocalDateTime(at) }
function openHistory(): void {
  historyOpen.value = true
  void loadHistory(1)
}
async function loadHistory(page: number): Promise<void> {
  const request = ++historyRequest
  historyLoading.value = true
  historyError.value = ''
  try {
    const response = await fetch(`/codex-api/api-proxy/activation/history?page=${page}`)
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error?.message || '读取激活记录失败')
    if (!disposed && request === historyRequest) history.value = payload.data
  } catch (cause) {
    if (!disposed && request === historyRequest) historyError.value = cause instanceof Error ? cause.message : '读取激活记录失败'
  } finally {
    if (request === historyRequest) historyLoading.value = false
  }
}
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
    notifyOperation(cause instanceof Error ? cause.message : '时间格式应为 HH:mm')
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
  } catch (cause) { notifyOperation(cause instanceof Error ? cause.message : '保存失败') }
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
