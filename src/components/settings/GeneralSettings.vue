<template>
  <div class="settings-form-grid">
    <ConversationDefaults
      :value="webDefaultChoice"
      :remember="webPreferenceState.remember"
      :models="availableModels"
      :provider="webDefaultsProvider"
      :has-account="!!activeAccount"
      :error="webPreferenceError"
      @save="configureWebDefaults"
    />
    <div class="sidebar-settings-row sidebar-settings-row--select" :title="t('Choose the interface language for the app.')">
      <span class="sidebar-settings-label">{{ t('UI language') }}</span>
      <AppSelect
        class="sidebar-settings-provider-dropdown"
        :model-value="uiLanguage"
        :options="uiLanguageOptions"
        :placeholder="t('UI language')"
        menu-align="end"
        @update:model-value="setUiLanguage($event as 'en' | 'zh-CN')"
      />
    </div>
    <div class="sidebar-settings-row sidebar-settings-timezone settings-field-roomy">
      <span class="sidebar-settings-label">{{ t('Display timezone') }}</span>
      <AppSelect
        :model-value="displayTimeZonePreference"
        :disabled="isSavingDisplayTimeZone"
        :options="displayTimeZoneOptions"
        :placeholder="t('Display timezone')"
        enable-search
        :search-placeholder="t('Search timezones')"
        menu-align="end"
        @update:model-value="onDisplayTimeZoneChange"
      />
    </div>
    <p v-if="displayTimeZoneError" class="sidebar-timezone-error settings-field-wide" role="alert">{{ t(displayTimeZoneError) }}</p>
  </div>
</template>

<script setup lang="ts">
import AppSelect from '../common/AppSelect.vue'
import ConversationDefaults from './ConversationDefaults.vue'
import { useDisplayTimeZoneSettings } from '../../composables/useDisplayTimeZoneSettings'
import { useUiLanguage } from '../../composables/useUiLanguage'
import type { ModelCapability } from '../../modelCapabilities'
import type { ConversationChoice } from '../../webConversationPreferences'
import type { UiAccountEntry } from '../../types/codex'

defineProps<{
  webPreferenceState: { remember: boolean }
  webDefaultChoice: ConversationChoice
  availableModels: ModelCapability[]
  webDefaultsProvider: string
  activeAccount: UiAccountEntry | undefined
  webPreferenceError: string
}>()

const emit = defineEmits<{ save: [value: ConversationChoice, remember: boolean] }>()
const { t, uiLanguage, uiLanguageOptions, setUiLanguage } = useUiLanguage()
const {
  displayTimeZonePreference,
  displayTimeZoneError,
  isSavingDisplayTimeZone,
  displayTimeZoneOptions,
  onDisplayTimeZoneChange,
} = useDisplayTimeZoneSettings()

function configureWebDefaults(value: ConversationChoice, remember: boolean): void {
  emit('save', value, remember)
}
</script>
