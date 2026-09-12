<template>
  <AppButton :disabled="disabled" @click="open">{{ t('账号设置') }}</AppButton>
  <AppDialog :open="visible" :title="t('账号设置')" :busy="busy" size="compact" @close="visible = false">
    <p>{{ account.email || account.accountId }}</p>
    <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <div v-if="loaded" class="notification-settings account-options">
      <label>{{ t('账号别名') }}<input v-model="alias" class="app-input" maxlength="80" :disabled="busy" /></label>
      <label>{{ t('保护值（%）') }}<input v-model.number="percent" class="app-input" type="number" min="0" max="100" step="0.1" :disabled="busy" /></label>
      <small>{{ t('保护值范围内的主额度仅限受保护任务使用') }}</small>
      <small v-if="hasFiveHourQuota">{{ t('5 小时额度保护值：') }}{{ Math.min(100, Number(percent) * 2) }}{{ t('%。只作用于此账号实际存在的 5 小时窗口。') }}</small>
      <section class="account-notice-rule">
        <AppSwitch class="notification-check" v-model="rule.fiveHour"  :disabled="busy">{{ t('5小时额度恢复通知') }}</AppSwitch>
        <template v-if="rule.fiveHour">
          <textarea v-model="rule.fiveHourMessage" class="app-input" rows="3" :aria-label="t('5小时恢复通知内容')" :disabled="busy" />
          <small v-text="t('占位符：{{account}} 账号、{{account_id}} 账号标识、{{window}} 额度窗口、{{remaining}} 剩余百分比、{{reset_at}} 重置时间。')"></small>
        </template>
      </section>
      <section class="account-notice-rule">
        <AppSwitch class="notification-check" v-model="rule.weekly"  :disabled="busy">{{ t('主额度恢复通知') }}</AppSwitch>
        <template v-if="rule.weekly">
          <textarea v-model="rule.weeklyMessage" class="app-input" rows="3" :aria-label="t('主额度恢复通知内容')" :disabled="busy" />
          <small v-text="t('占位符：{{account}} 账号、{{account_id}} 账号标识、{{window}} 额度窗口、{{remaining}} 剩余百分比、{{reset_at}} 重置时间。')"></small>
        </template>
      </section>
      <section class="account-notice-rule">
        <AppSwitch class="notification-check" v-model="rule.resetIncrease"  :disabled="busy">{{ t('重置机会增加提醒') }}</AppSwitch>
        <template v-if="rule.resetIncrease">
          <textarea v-model="rule.resetIncreaseMessage" class="app-input" rows="3" :aria-label="t('重置机会增加提醒内容')" :disabled="busy" />
          <small>{{ t('首次读取仅记录次数，之后增加时通知。') }}</small>
          <small v-text="t('占位符：{{account}} 账号、{{account_id}} 账号标识、{{increase}} 增加次数、{{remaining}} 当前次数、{{previous}} 之前次数。')"></small>
        </template>
      </section>
      <section class="account-notice-rule">
        <AppSwitch class="notification-check" v-model="rule.resetExpiry"  :disabled="busy">{{ t('重置机会到期提醒') }}</AppSwitch>
        <template v-if="rule.resetExpiry">
          <label>{{ t('提前时间') }}<input v-model="rule.resetExpiryLeadTimes" class="app-input" :aria-label="t('重置提醒提前时间')" placeholder="7d, 3d, 12h" :disabled="busy" /></label>
          <small>{{ t('支持英文逗号、中文逗号或空格分隔；1d12h 表示 1 天 12 小时。') }}</small>
          <textarea v-model="rule.resetExpiryMessage" class="app-input" rows="3" :aria-label="t('重置机会到期提醒内容')" :disabled="busy" />
          <small v-text="t('占位符：{{account}} 账号、{{account_id}} 账号标识、{{credit_id}} 机会标识、{{expires_at}} 到期时间、{{remaining}} 剩余时长、{{lead_time}} 提前时长。')"></small>
        </template>
      </section>
    </div>
    <template #footer><AppButton :disabled="busy" @click="visible = false">{{ t('取消') }}</AppButton><AppButton :disabled="!loaded" :busy="busy" @click="save">{{ t('保存账号设置') }}</AppButton></template>
  </AppDialog>
</template>
<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import AppSwitch from '../common/AppSwitch.vue'
import { t } from '../../composables/useUiLanguage'

import { computed, ref } from 'vue'
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
const initialPercent = ref(0)
const alias = ref('')
const hasFiveHourQuota = computed(() => [props.account.quotaSnapshot?.primary, props.account.quotaSnapshot?.secondary].some(window => window?.windowMinutes === 300))
const rule = ref<AccountNoticeRule>({ ...defaultNoticeRule })
async function open(): Promise<void> {
  visible.value = true
  loaded.value = false
  error.value = ''
  initialPercent.value = props.account.protectionPercent || 0
  percent.value = initialPercent.value
  alias.value = props.account.alias || ''
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
    await apiProxyRequest('/notifications', { accountId: props.account.storageId, rule: rule.value, protectionPercent: percent.value !== initialPercent.value ? percent.value : undefined, alias: alias.value })
    visible.value = false
    emit('changed')
  } catch (cause) { notifyOperation(cause instanceof Error ? cause.message : '保存失败。') }
  finally { busy.value = false }
}
</script>

<style scoped>
.account-options .account-notice-rule { display: grid; gap: 8px; padding-top: 14px; border-top: 1px solid var(--ui-divider); }
.account-options .account-notice-rule label { display: grid; gap: 6px; font-size: 13px; }
.account-options .account-notice-rule .notification-check { display: flex; }
</style>
