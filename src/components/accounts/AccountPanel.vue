<template>
  <div class="account-panel">
    <header class="account-panel-header">
      <h3>{{ t('OpenAI账号') }} <small>{{ accounts.length }}</small></h3>
      <AppButton :disabled="busy" :title="t('刷新账号列表')" :aria-label="t('刷新账号列表')" @click="$emit('refresh')">↻</AppButton>
      <AppButton :disabled="busy" @click="$emit('add')">{{ t('Add account') }}</AppButton>
    </header>
    <p v-if="error" class="account-panel-error" role="alert">{{ t(error) }}</p>
    <p v-if="notice" class="account-panel-notice" role="status">{{ t(notice) }}</p>
    <div class="account-panel-list account-panel-list--quota">
      <p v-if="!accounts.length" class="account-panel-empty">{{ t('No accounts yet. Add one from this panel.') }}</p>
      <article v-for="account in accounts" :key="account.storageId" class="account-card" :class="{ 'is-active': account.isActive }" :data-account-id="account.storageId">
        <div class="account-card-heading">
          <strong :title="account.email || account.accountId">{{ accountDisplayName(account) }}</strong>
          <span class="account-plan-badge">{{ account.planType || t('unknown') }}</span>
        </div>
        <p v-if="account.authStatus !== 'ready'" class="account-card-meta">{{ t(status(account)) }}</p>
        <p v-if="account.quotaUpdatedAtIso" class="account-card-meta">{{ t('更新于') }} {{ formatLocalDateTime(account.quotaUpdatedAtIso, { second: '2-digit' }) }}</p>
        <p v-if="account.protectionPercent" class="account-card-meta">{{ t('主额度保护') }} {{ account.protectionPercent }}%<span v-if="account.quotaSnapshot?.primary?.windowMinutes === 300 || account.quotaSnapshot?.secondary?.windowMinutes === 300"> {{ t('· 5h保护') }} {{ Math.min(100, account.protectionPercent * 2) }}%</span></p>
        <AccountQuota v-if="account.quotaSnapshot" :snapshot="account.quotaSnapshot" />
        <p v-else class="account-card-meta">{{ account.quotaStatus === 'loading' ? t('Loading quota…') : t('Quota unavailable') }}</p>
        <p v-if="account.quotaError" class="account-panel-error">{{ t(account.quotaError) }}</p>
        <AccountResetCredits :account="account" :disabled="busy" @changed="$emit('reload')" />
        <footer class="account-card-actions">
          <AccountOptions :account="account" @changed="$emit('reload')" />
          <AppButton v-if="account.isActive" class="account-current-button" disabled>{{ t('当前使用') }}</AppButton>
          <AppButton v-else :disabled="disabled(account) || !account.canSwitch" @click="$emit('switch', account.storageId)">{{ t('切换至此账号') }}</AppButton>
          <AppButton v-if="account.actionRequired === 'reauthenticate'" :disabled="disabled(account)" @click="$emit('reauth', account.storageId)">{{ t('Re-authenticate') }}</AppButton>
          <span class="account-card-spacer" />
          <div :ref="element => setAnchor(account.storageId, element)" class="account-more-anchor">
            <AppButton :aria-label="t('账号更多操作')" :aria-expanded="menuId === account.storageId" @click="menuId = menuId === account.storageId ? '' : account.storageId">⋯</AppButton>
          </div>
          <AppPopover :open="menuId === account.storageId" :anchor="anchors[account.storageId] || null" direction="up" align="end" panel-class="account-actions-menu" @close="menuId = ''">
            <p class="account-card-meta" :title="account.accountId">Workspace {{ account.accountId }}</p>
            <AppButton :disabled="disabled(account)" @click="run('quota', account.storageId)">{{ t('Refresh quota') }}</AppButton>
            <AppButton :disabled="disabled(account)" @click="run('reauth', account.storageId)">{{ t('Re-authenticate') }}</AppButton>
            <AppButton variant="danger" @click="$emit('remove', account.storageId)">{{ t(confirmingRemoveId === account.storageId ? '确认移除并中断' : t('Remove')) }}</AppButton>
          </AppPopover>
        </footer>
      </article>
    </div>
    <footer v-if="$slots.footer" class="account-panel-footer"><slot name="footer" /></footer>
  </div>
</template>

<script setup lang="ts">
import { accountDisplayName } from '../../accountDisplay'
import { ref, type ComponentPublicInstance } from 'vue'
import type { UiAccountEntry } from '../../types/codex'
import { useUiLanguage } from '../../composables/useUiLanguage'
import AppButton from '../common/AppButton.vue'
import AppPopover from '../common/AppPopover.vue'
import { formatLocalDateTime } from '../../dateTime'
import AccountOptions from './AccountOptions.vue'
import AccountResetCredits from './AccountResetCredits.vue'
import AccountQuota from './AccountQuota.vue'

defineProps<{
  accounts: UiAccountEntry[]
  busy: boolean
  error: string
  notice: string
  confirmingRemoveId: string
  disabled: (account: UiAccountEntry) => boolean
  status: (account: UiAccountEntry) => string
}>()
const emit = defineEmits<{
  reload: []
  refresh: []
  add: []
  switch: [storageId: string]
  quota: [storageId: string]
  reauth: [storageId: string]
  remove: [storageId: string]
}>()
const { t } = useUiLanguage()
const menuId = ref('')
const anchors = ref<Record<string, HTMLElement>>({})
function setAnchor(id: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) anchors.value[id] = element
  else delete anchors.value[id]
}
function run(action: 'quota' | 'reauth', id: string): void {
  menuId.value = ''
  if (action === 'quota') emit('quota', id)
  else emit('reauth', id)
}
</script>
