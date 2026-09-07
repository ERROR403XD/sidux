<template>
  <div class="account-activation">
    <div class="account-panel-header"><h3>定时激活</h3><AppButton :busy="loading" :disabled="saving" @click="load">刷新结果</AppButton></div>
    <p v-if="error" class="account-panel-error" role="alert">{{ error }}</p>
    <template v-if="snapshot">
      <button class="sidebar-settings-row" type="button" role="switch" :aria-checked="settings.enabled" :disabled="saving" @click="settings.enabled = !settings.enabled"><span>启用账号定时激活</span><span class="sidebar-settings-toggle" :class="{ 'is-on': settings.enabled }" /></button>
      <p class="account-card-meta">到点仅对 5h 额度剩余 100% 且没有活动连接的账号发送；其他情况跳过，不补发。</p>
      <fieldset class="activation-accounts"><legend>生效账号</legend>
        <label v-for="account in accounts" :key="account.storageId"><input v-model="settings.accountIds" type="checkbox" :value="account.storageId" :disabled="saving" /><span :title="account.email || account.accountId">{{ account.email || account.accountId }}</span></label>
        <p v-if="!accounts.length" class="account-card-meta">请先添加 GPT 账号。</p>
      </fieldset>
      <div class="activation-times"><span>每日激活时间</span>
        <div v-for="(_, index) in settings.times" :key="index" class="activation-time-row"><input v-model="settings.times[index]" class="app-input" type="time" :aria-label="`激活时间 ${index + 1}`" :disabled="saving" /><AppButton :disabled="saving" @click="settings.times.splice(index, 1)">移除</AppButton></div>
        <AppButton :disabled="saving || settings.times.length >= 24" @click="settings.times.push('08:00')">添加时间</AppButton>
      </div>
      <div class="sidebar-settings-row sidebar-settings-row--select"><span>计划时区</span><AppSelect v-model="settings.timezone" :options="timezoneOptions" enable-search :disabled="saving" /></div>
      <div class="activation-save"><AppButton :busy="saving" :disabled="loading" @click="save">保存激活计划</AppButton><span v-if="saved" role="status">已保存</span></div>
      <p class="account-card-meta">下次计划：{{ snapshot.nextAt ? formatPlanDate(snapshot.nextAt) : '未启用' }}</p>
      <div v-if="recent.length" class="activation-results"><div v-for="run in recent" :key="run.key"><strong>{{ accountName(run.accountId) }}</strong><span>{{ run.finishedAt ? formatPlanDate(run.finishedAt) : '准备中' }} · {{ labels[run.status] }}</span><small>{{ run.reason }}</small></div></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppSelect from '../common/AppSelect.vue'
import AppButton from '../common/AppButton.vue'
import type { UiAccountEntry } from '../../types/codex'
import { availableDisplayTimeZones, displayTimeZone } from '../../dateTime'
import { validateActivationSettings, type ActivationSettings, type ActivationSnapshot } from '../../accountActivation'
const props = defineProps<{ accounts: UiAccountEntry[] }>()
const snapshot = ref<ActivationSnapshot | null>(null)
const settings = ref<ActivationSettings>({ enabled: false, accountIds: [], times: [], timezone: displayTimeZone() })
const error = ref('')
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const timezoneOptions = computed(() => [...new Set([settings.value.timezone, ...availableDisplayTimeZones()])].map(zone => ({ value: zone, label: zone })))
const recent = computed(() => snapshot.value?.runs.filter((run, index, rows) => rows.findIndex(row => row.accountId === run.accountId) === index) || [])
const labels = { preparing: '准备中', sending: '发送中', sent: '发送成功', skipped: '已跳过', unknown: '结果未确认' }
function formatPlanDate(at: number): string { return new Intl.DateTimeFormat('zh-CN', { timeZone: snapshot.value?.settings.timezone || settings.value.timezone, dateStyle: 'short', timeStyle: 'short' }).format(at) }
function accountName(id: string): string { const account = props.accounts.find(row => row.storageId === id); return account?.email || (account ? 'GPT 账号' : '已移除的账号') }
async function request(init?: RequestInit): Promise<ActivationSnapshot> {
  const response = await fetch('/codex-api/api-proxy/activation', init)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error?.message || '激活设置暂不可用')
  return payload.data
}
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const next = await request()
    if (!snapshot.value) settings.value = { ...next.settings, timezone: next.settings.times.length ? next.settings.timezone : displayTimeZone() }
    snapshot.value = next
    error.value = next.error
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败' }
  finally { loading.value = false }
}
async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  error.value = ''
  try {
    const value = validateActivationSettings(settings.value)
    snapshot.value = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    settings.value = { ...snapshot.value.settings, accountIds: [...snapshot.value.settings.accountIds], times: [...snapshot.value.settings.times] }
    saved.value = true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { saving.value = false }
}
onMounted(load)
</script>
