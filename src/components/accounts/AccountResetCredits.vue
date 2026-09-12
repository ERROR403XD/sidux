<template>
  <div v-if="count > 0" class="account-reset-credits" :aria-label="t('可用重置机会')">
    <AppButton v-for="(credit, index) in shown" :key="credit?.id || index" :disabled="disabled || !credit || busy" :title="t(credit ? expiry(credit) : '到期明细暂不可用，请刷新账号')" :aria-label="t(credit ? `使用重置机会，${expiry(credit)}` : '重置机会明细未知')" @click="choose(credit)">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" /><path d="m13 7-4 6h4l-2 5 6-8h-4z" /></svg>
    </AppButton>
    <span v-if="count > 3">+{{ count - 3 }}{{ t('次重置') }}</span>
  </div>
  <AppDialog :open="!!target" :title="t('确认使用重置机会')" size="compact" :busy="busy" @close="target = null">
    <p>{{ t('账号：') }}{{ accountDisplayName(account) }}</p>
    <p v-if="target">{{ t(expiry(target)) }}</p>
    <p>{{ t('确认后消耗一次重置机会，并重置上游允许的额度窗口。') }}</p>
    <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <template #footer><AppButton :disabled="busy" @click="target = null">{{ t('取消') }}</AppButton><AppButton :busy="busy" @click="consume">{{ t('确认使用一次') }}</AppButton></template>
  </AppDialog>
</template>
<script setup lang="ts">
import { notifyOperation } from '../../composables/useOperationToast'
import { t } from '../../composables/useUiLanguage'

import { accountDisplayName } from '../../accountDisplay'
import { computed, ref } from 'vue'
import AppButton from '../common/AppButton.vue'
import AppDialog from '../common/AppDialog.vue'
import { availableResetCredits, type ResetCredit } from '../../accountResetCredits'
import type { UiAccountEntry } from '../../types/codex'
import { formatLocalDateTime } from '../../dateTime'
import { useQuotaClock } from '../../composables/useQuotaClock'
import { requestUuid } from '../../utils/requestUuid'
const props = defineProps<{ account: UiAccountEntry; disabled?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const now = useQuotaClock()
const credits = computed(() => availableResetCredits(props.account.resetCredits, now.value))
const count = computed(() => {
  const expired = (props.account.resetCredits?.credits || []).filter(credit => credit.status === 'available' && credit.expiresAt !== null && credit.expiresAt * 1000 <= now.value).length
  return Math.max(credits.value.length, (props.account.resetCredits?.availableCount || 0) - expired)
})
const shown = computed(() => Array.from({ length: Math.min(3, count.value) }, (_, index) => credits.value[index] || null))
const target = ref<ResetCredit | null>(null)
const busy = ref(false)
const error = ref('')
let attempt = ''
function expiry(credit: ResetCredit): string { return credit.expiresAt ? `到期：${formatLocalDateTime(credit.expiresAt * 1000)}` : '无到期时间' }
function choose(credit: ResetCredit | null): void {
  if (!credit) return
  attempt = requestUuid()
  target.value = credit
  error.value = ''

}
async function consume(): Promise<void> {
  if (!target.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const response = await fetch('/codex-api/accounts/reset-credit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storageId: props.account.storageId, creditId: target.value.id, idempotencyKey: attempt, confirmed: true }) })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.message || '重置结果未确认，请核对额度后重试。')
    const outcome = ({ reset: '额度已重置', alreadyRedeemed: '该次重置已完成', nothingToReset: '当前没有可重置的额度窗口', noCredit: '此重置机会已不可用' } as Record<string, string>)[payload.data?.outcome]
    if (!outcome) {
      notifyOperation('结果未确认，请刷新账号核对。')
      return
    }
    notifyOperation(outcome, ['reset', 'alreadyRedeemed'].includes(payload.data?.outcome) ? 'success' : 'error')
    target.value = null
  } catch (cause) { notifyOperation(cause instanceof Error ? cause.message : '重置结果未确认。') }
  finally {
    busy.value = false
    emit('changed')
  }
}
</script>
