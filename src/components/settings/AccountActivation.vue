<template>
  <div class="account-activation">
    <div class="account-panel-header"><h3>定时激活</h3><AppButton :busy="loading" :disabled="saving" @click="load">刷新结果</AppButton></div>
    <p v-if="error" class="account-panel-error" role="alert">{{ error }}</p>
    <template v-if="snapshot">
      <button class="sidebar-settings-row" type="button" role="switch" :aria-checked="settings.enabled" :disabled="saving" @click="settings.enabled = !settings.enabled"><span>启用账号定时激活</span><span class="sidebar-settings-toggle" :class="{ 'is-on': settings.enabled }" /></button>
      <fieldset class="activation-accounts"><legend>生效账号</legend>
        <label v-for="account in accounts" :key="account.storageId"><input v-model="settings.accountIds" type="checkbox" :value="account.storageId" :disabled="saving" /><span :title="account.email || account.accountId">{{ account.email || account.accountId }}</span></label>
        <p v-if="!accounts.length" class="account-card-meta">请先添加 GPT 账号。</p>
      </fieldset>
      <div class="activation-times"><span>每日激活时间</span>
        <div v-for="(_, index) in settings.times" :key="index" class="activation-time-row"><input :value="settings.times[index]?.split(':')[0]" class="app-input activation-time-part" type="text" inputmode="numeric" maxlength="2" :aria-label="`激活小时 ${index + 1}`" placeholder="HH" :disabled="saving" @input="setTimePart(index, 0, $event)" /><span>:</span><input :value="settings.times[index]?.split(':')[1]" class="app-input activation-time-part" type="text" inputmode="numeric" maxlength="2" :aria-label="`激活分钟 ${index + 1}`" placeholder="mm" :disabled="saving" @input="setTimePart(index, 1, $event)" /><AppButton :disabled="saving" @click="settings.times.splice(index, 1)">移除</AppButton></div>
        <AppButton :disabled="saving || settings.times.length >= 24" @click="settings.times.push('08:00')">添加时间</AppButton>
      </div>
      <div class="activation-save"><AppButton :busy="saving" :disabled="loading" @click="save">保存激活计划</AppButton><span v-if="saved" role="status">已保存</span></div>
      <p class="account-card-meta">下次计划：{{ snapshot.nextAt ? formatPlanDate(snapshot.nextAt) : '未启用' }}</p>
      <div v-if="recent.length" class="activation-results"><div v-for="run in recent" :key="run.key"><strong>{{ accountName(run.accountId) }}</strong><span>{{ run.finishedAt ? formatPlanDate(run.finishedAt) : '准备中' }} · {{ labels[run.status] }}</span><small>{{ run.reason }}</small></div></div>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import type { UiAccountEntry } from '../../types/codex'
import { formatLocalDateTime, displayTimeZone } from '../../dateTime'
import { validateActivationSettings, type ActivationSettings, type ActivationSnapshot } from '../../accountActivation'
const props = defineProps<{ accounts: UiAccountEntry[] }>()
const snapshot = ref<ActivationSnapshot | null>(null)
const settings = ref<ActivationSettings>({ enabled: false, accountIds: [], times: [], timezone: displayTimeZone() })
const error = ref('')
const loading = ref(false)
const saving = ref(false)
const saved = ref(false)
const recent = computed(() => snapshot.value?.runs.filter((run, index, rows) => rows.findIndex(row => row.accountId === run.accountId) === index) || [])
const labels = { preparing: '准备中', sending: '发送中', sent: '发送成功', skipped: '已跳过', unknown: '结果未确认' }
function formatPlanDate(at: number): string { return formatLocalDateTime(at) }
function setTimePart(index: number, part: number, event: Event): void {
  const input = event.target as HTMLInputElement
  const pieces = (settings.value.times[index] || ':').split(':')
  pieces[part] = input.value.replace(/\D/g, '').slice(0, 2)
  input.value = pieces[part]!
  settings.value.times[index] = pieces.join(':')
  saved.value = false
}
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
    let next = await request()
    if (next.settings.timezone !== displayTimeZone()) {
      next = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...next.settings, timezone: displayTimeZone() }) })
    }
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
    if (settings.value.times.some(time => !/^\d{1,2}:\d{1,2}$/.test(time))) throw new Error('请输入完整的小时和分钟。')
    const value = validateActivationSettings({ ...settings.value, timezone: displayTimeZone(), times: settings.value.times.map(time => time.split(':').map(part => part.padStart(2, '0')).join(':')) })
    snapshot.value = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    settings.value = { ...snapshot.value.settings, accountIds: [...snapshot.value.settings.accountIds], times: [...snapshot.value.settings.times] }
    saved.value = true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败' }
  finally { saving.value = false }
}
onMounted(load)
</script>
