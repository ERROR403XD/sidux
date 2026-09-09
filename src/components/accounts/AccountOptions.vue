<template>
  <AppButton :disabled="disabled" @click="open">账号设置</AppButton>
  <AppDialog :open="visible" title="账号保护与通知" :busy="busy" size="compact" @close="visible = false">
    <p>{{ account.email || account.accountId }}</p>
    <p v-if="error" class="account-panel-error" role="alert">{{ error }}</p>
    <div v-if="loaded" class="notification-settings">
      <label>保护值（%）<input v-model.number="percent" class="app-input" type="number" min="0" max="100" step="0.1" :disabled="busy" /></label>
      <small v-if="account.quotaSnapshot?.primary?.windowMinutes === 300 || account.quotaSnapshot?.secondary?.windowMinutes === 300">5小时额度保护值：{{ Math.min(100, Number(percent) * 2) }}%。预留给使用此账号的受保护任务；0为关闭。</small>
      <label class="notification-check"><input v-model="rule.fiveHour" type="checkbox" :disabled="busy" />5小时额度恢复通知</label>
      <textarea v-if="rule.fiveHour" v-model="rule.fiveHourMessage" class="app-input" rows="3" aria-label="5小时恢复通知内容" :disabled="busy" />
      <label class="notification-check"><input v-model="rule.weekly" type="checkbox" :disabled="busy" />主额度恢复通知</label>
      <textarea v-if="rule.weekly" v-model="rule.weeklyMessage" class="app-input" rows="3" aria-label="主额度恢复通知内容" :disabled="busy" />
      <small v-pre>可用占位符：{{account}}、{{account_id}}、{{window}}、{{remaining}}、{{reset_at}}。通过设置中的POST通知发送。</small>
    </div>
    <template #footer><AppButton :disabled="busy" @click="visible = false">取消</AppButton><AppButton :disabled="!loaded" :busy="busy" @click="save">保存账号设置</AppButton></template>
  </AppDialog>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import type { UiAccountEntry } from '../../types/codex'
import { defaultNoticeRule, type AccountNoticeRule } from '../../accountNotifications'
import { apiProxyRequest } from '../../api/apiProxy'
const props = defineProps<{ account: UiAccountEntry; disabled?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const visible = ref(false)
const busy = ref(false)
const loaded = ref(false)
const error = ref('')
const percent = ref(0)
const rule = ref<AccountNoticeRule>({ ...defaultNoticeRule })
async function open(): Promise<void> {
  visible.value = true
  loaded.value = false
  error.value = ''
  percent.value = props.account.protectionPercent || 0
  try {
    const result = await apiProxyRequest<{ accounts: Record<string, AccountNoticeRule> }>('/notifications')
    rule.value = { ...defaultNoticeRule, ...result.accounts[props.account.storageId] }
    loaded.value = true
  } catch { error.value = '读取账号设置失败。' }
}
async function save(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await apiProxyRequest('/notifications', { accountId: props.account.storageId, rule: rule.value, protectionPercent: percent.value })
    visible.value = false
    emit('changed')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败。' }
  finally { busy.value = false }
}
</script>
