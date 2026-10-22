<template>
  <SettingsPanel>
    <template #accounts>
      <AccountPanel
        :accounts="accounts"
        :busy="isAccountPanelBusy"
        :error="accountActionError"
        :confirming-remove-id="confirmingRemoveAccountId"
        :disabled="isAccountActionDisabled"
        :status="formatAccountStatus"
        @reload="reload"
        @refresh="refresh"
        @add="add"
        @switch="switchAccount"
        @quota="refreshQuota"
        @reauth="reauth"
        @remove="remove"
      />
      <CustomConnections @changed="customConnectionsChanged" />
      <AccountActivation :key="displayTimeZonePreference" :accounts="accounts" />
    </template>
    <template #general>
      <GeneralSettings
        :web-preference-state="webPreferenceState"
        :web-default-choice="webDefaultChoice"
        :available-models="availableModels"
        :web-defaults-provider="webDefaultsProvider"
        :active-account="activeAccount"
        :web-preference-error="webPreferenceError"
        @save="saveWebDefaults"
      />
    </template>
    <template #appearance><AppearanceSettings /></template>
    <template #input><InputPreferencesSettings /></template>
    <template #integrations>
      <div class="settings-integrations-grid">
        <ConversationNotificationSettings />
        <NotificationSettings :key="displayTimeZonePreference" />
        <TelegramSettings />
      </div>
    </template>
    <template #about>
      <RuntimeCapabilitiesSettings />
      <a
        v-if="hasVisibleFeedbackError"
        class="sidebar-settings-row sidebar-settings-feedback-row"
        :href="feedbackMailto"
        @click="prepareFeedbackLink"
      >
        <span class="sidebar-settings-label">{{ t('Send feedback') }}</span>
        <span class="sidebar-settings-value">{{ t('Issue detected') }}</span>
      </a>
    </template>
  </SettingsPanel>
</template>

<script setup lang="ts">
import AccountActivation from './AccountActivation.vue'
import AccountPanel from '../accounts/AccountPanel.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import CustomConnections from '../accounts/CustomConnections.vue'
import GeneralSettings from './GeneralSettings.vue'
import InputPreferencesSettings from './InputPreferencesSettings.vue'
import NotificationSettings from './NotificationSettings.vue'
import ConversationNotificationSettings from './ConversationNotificationSettings.vue'
import RuntimeCapabilitiesSettings from './RuntimeCapabilitiesSettings.vue'
import SettingsPanel from './SettingsPanel.vue'
import TelegramSettings from './TelegramSettings.vue'
import { t } from '../../composables/useUiLanguage'
import { displayTimeZonePreference } from '../../dateTime'
import type { ModelCapability } from '../../modelCapabilities'
import type { ConversationChoice } from '../../webConversationPreferences'
import type { UiAccountEntry } from '../../types/codex'

defineProps<{
  accounts: UiAccountEntry[]
  activeAccount: UiAccountEntry | undefined
  isAccountPanelBusy: boolean
  accountActionError: string
  confirmingRemoveAccountId: string
  isAccountActionDisabled: (account: UiAccountEntry) => boolean
  formatAccountStatus: (account: UiAccountEntry) => string
  webPreferenceState: { remember: boolean }
  webDefaultChoice: ConversationChoice
  availableModels: ModelCapability[]
  webDefaultsProvider: string
  webPreferenceError: string
  hasVisibleFeedbackError: boolean
  feedbackMailto: string
  prepareFeedbackLink: (event: MouseEvent, message?: string) => void
}>()

const emit = defineEmits<{
  'reload-accounts': []
  'refresh-accounts': []
  'add-account': []
  'switch-account': [storageId: string]
  'refresh-account-quota': [storageId: string]
  'reauth-account': [storageId: string]
  'remove-account': [storageId: string]
  'custom-connections-changed': [accountChanged: boolean]
  'save-web-defaults': [value: ConversationChoice, remember: boolean]
}>()

function reload(): void {
  emit('reload-accounts')
}

function refresh(): void {
  emit('refresh-accounts')
}

function add(): void {
  emit('add-account')
}

function switchAccount(storageId: string): void {
  emit('switch-account', storageId)
}

function refreshQuota(storageId: string): void {
  emit('refresh-account-quota', storageId)
}

function reauth(storageId: string): void {
  emit('reauth-account', storageId)
}

function remove(storageId: string): void {
  emit('remove-account', storageId)
}

function customConnectionsChanged(accountChanged: boolean): void {
  emit('custom-connections-changed', accountChanged)
}

function saveWebDefaults(value: ConversationChoice, remember: boolean): void {
  emit('save-web-defaults', value, remember)
}
</script>
