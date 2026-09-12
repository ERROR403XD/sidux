<template>
  <AppDialog :open="open" :title="t(intent === 'reauth' ? '重新登录账号' : '登录新账号')" :busy="busy || verifying" size="compact" panel-class="account-login-dialog" @close="cancel">
    <div class="account-login-fields">
      <label>{{ t('登录方式') }}<AppSelect :model-value="method" :options="methods.map(option => ({ ...option, label: t(option.label) }))" :disabled="busy || verifying" @update:model-value="changeMethod" /></label>
      <p v-if="targetLabel">{{ t('预期账号：') }}{{ targetLabel }}</p>
      <p>{{ t(method === 'link' ? '打开授权链接，完成登录后将浏览器的完整 localhost 回调链接粘贴到下方。' : '打开验证网页，输入设备码。授权完成后会自动验证并加入账号列表。') }}</p>
      <template v-if="session">
        <a v-if="session.loginUrl" :href="session.loginUrl" target="_blank" rel="noopener noreferrer">{{ t(method === 'link' ? '打开授权链接' : '打开验证网页') }}</a>
        <template v-if="method === 'device' && session.userCode">
          <output class="account-login-code" :aria-label="t('设备授权码')">{{ session.userCode }}</output>
          <AppButton @click="copyCode">{{ t('复制设备码') }}</AppButton>
        </template>
        <label v-if="method === 'link'">{{ t('回调链接') }}<input v-model="callback" class="app-input" type="url" :placeholder="t('粘贴完整 localhost 回调链接')" :disabled="busy" @keydown.enter.prevent="completeLink" /></label>
        <p role="status">{{ t(verifying ? '正在验证账号…' : terminal ? '本次登录已结束，可重新开始。' : method === 'device' ? '等待设备授权…' : '等待回调链接…') }}</p>
        <small v-if="session.expiresAt && !terminal">{{ t('有效期至') }} {{ formatLocalDateTime(session.expiresAt) }}</small>
      </template>
      <p v-if="error" role="alert" class="account-login-error">{{ t(error) }}</p>
    </div>
    <template #footer>
      <AppButton :disabled="busy || verifying" @click="cancel">{{ t('取消') }}</AppButton>
      <AppButton v-if="!session || terminal" :busy="busy" @click="start">{{ t('开始登录') }}</AppButton>
      <AppButton v-else-if="method === 'link'" :busy="busy" :disabled="!callback.trim()" @click="completeLink">{{ t('完成登录') }}</AppButton>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import { t } from '../../composables/useUiLanguage'

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppDialog from '../common/AppDialog.vue'
import AppSelect from '../common/AppSelect.vue'
import AppButton from '../common/AppButton.vue'
import { cancelCodexLogin, completeCodexLogin, getCodexLoginStatus, startCodexLogin, type AccountLoginCompleteResult, type AccountLoginStatus } from '../../api/codexGateway'
import { copyTextToClipboard } from '../../utils/clipboard'
import { formatLocalDateTime } from '../../dateTime'

const props = defineProps<{ open: boolean; intent: 'add' | 'reauth'; targetStorageId?: string; targetLabel?: string }>()
const emit = defineEmits<{ close: []; completed: [result: AccountLoginCompleteResult]; resume: [intent: 'add' | 'reauth', targetStorageId: string] }>()
const method = ref<'link' | 'device'>('link')
const methods = [{ value: 'link', label: '链接登录 · 粘贴回调链接' }, { value: 'device', label: 'Device 登录 · 设备码' }]
const session = ref<AccountLoginStatus | null>(null)
const busy = ref(false)
const error = ref('')
const callback = ref('')
const verifying = computed(() => session.value?.status === 'verifying')
const terminal = computed(() => !!session.value && ['completed', 'failed', 'expired'].includes(session.value.status))
let polling = false
let disposed = false
let epoch = 0
let timer: ReturnType<typeof setInterval> | undefined

function succeeded(result: AccountLoginCompleteResult) {
  epoch++
  session.value = null
  callback.value = ''
  emit('completed', result)
}
async function poll(resume = false) {
  if (polling || disposed || busy.value || (!resume && (!props.open || !session.value || terminal.value || document.hidden))) return
  polling = true
  const generation = epoch
  try {
    const next = await getCodexLoginStatus()
    if (disposed || generation !== epoch) return
    if (!next) {
      if (!resume && session.value) {
        session.value = null
        error.value = '登录会话已结束，请重新开始。'
      }
      return
    }
    if (resume) {
      if (['completed', 'failed', 'expired'].includes(next.status)) return
      method.value = next.method || 'link'
      emit('resume', next.intent, next.targetStorageId || '')
    } else if (next.loginSessionId !== session.value?.loginSessionId) return
    session.value = next
    if (next.error) error.value = next.error
    if (next.status === 'completed' && next.result) succeeded(next.result)
  } catch (caught) { if (generation === epoch && !disposed) error.value = caught instanceof Error ? caught.message : '读取登录状态失败。' }
  finally { polling = false }
}
async function start() {
  if (busy.value || verifying.value) return
  busy.value = true
  error.value = ''
  epoch++
  try {
    const next = await startCodexLogin(props.intent, props.targetStorageId, method.value)
    if (disposed) { await cancelCodexLogin(next.loginSessionId); return }
    session.value = { ...next, intent: props.intent, targetStorageId: props.targetStorageId || null, status: 'waiting', error: null }
  } catch (caught) { notifyOperation(caught instanceof Error ? caught.message : '启动登录失败。') }
  finally { busy.value = false }
}
async function cancel() {
  if (busy.value || verifying.value) return
  busy.value = true
  epoch++
  try {
    if (session.value && !terminal.value) await cancelCodexLogin(session.value.loginSessionId)
    session.value = null
    callback.value = ''
    error.value = ''
    emit('close')
  } catch (caught) { notifyOperation(caught instanceof Error ? caught.message : '取消失败。') }
  finally { busy.value = false }
}
async function changeMethod(value: string) {
  if (busy.value || verifying.value || (value !== 'link' && value !== 'device') || value === method.value) return
  busy.value = true
  epoch++
  try {
    if (session.value && !terminal.value) await cancelCodexLogin(session.value.loginSessionId)
    session.value = null
    callback.value = ''
    error.value = ''
    method.value = value
  } catch (caught) { notifyOperation(caught instanceof Error ? caught.message : '切换登录方式失败。') }
  finally { busy.value = false }
}
async function completeLink() {
  if (busy.value || !session.value || !callback.value.trim()) return
  busy.value = true
  epoch++
  try { succeeded(await completeCodexLogin(session.value.loginSessionId, callback.value.trim())) }
  catch (caught) { notifyOperation(caught instanceof Error ? caught.message : '登录失败。') }
  finally { busy.value = false }
}
async function copyCode() {
  try { await copyTextToClipboard(session.value?.userCode || '') }
  catch { notifyOperation('复制失败，请手动选中设备码。') }
}
watch(() => props.open, open => { if (open && !session.value) error.value = '' })
onMounted(() => { void poll(true); timer = setInterval(() => { void poll() }, 2000) })
onUnmounted(() => { disposed = true; epoch++; if (timer) clearInterval(timer) })
</script>
