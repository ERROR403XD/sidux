<template>
  <div class="settings-form-grid">
    <AppSwitch class="settings-switch-row" :model-value="!sendWithEnter" :title="help.sendWithEnter" @change="toggleSendWithEnter">
      {{ t('Require ⌘ + enter to send') }}
    </AppSwitch>
    <div class="sidebar-settings-row sidebar-settings-row--select" :title="help.dictationLanguage">
      <span class="sidebar-settings-label">{{ t('Dictation language') }}</span>
      <AppSelect
        :model-value="dictationLanguage"
        :options="dictationLanguageOptions"
        :placeholder="t('Auto-detect')"
        open-direction="up"
        enable-search
        :search-placeholder="t('Search language...')"
        @update:model-value="onDictationLanguageChange"
      />
    </div>
    <AppSwitch class="settings-switch-row" :model-value="dictationClickToToggle" :title="help.dictationClickToToggle" @change="toggleDictationClickToToggle">
      {{ t('Click to toggle dictation') }}
    </AppSwitch>
    <AppSwitch class="settings-switch-row" :model-value="dictationAutoSend" :title="help.dictationAutoSend" @change="toggleDictationAutoSend">
      {{ t('Auto send dictation') }}
    </AppSwitch>
  </div>
</template>

<script setup lang="ts">
import AppSelect from '../common/AppSelect.vue'
import AppSwitch from '../common/AppSwitch.vue'
import { computed } from 'vue'
import { useInputPreferences } from '../../composables/useInputPreferences'
import { useUiLanguage } from '../../composables/useUiLanguage'

const { t } = useUiLanguage()
const {
  sendWithEnter,
  dictationClickToToggle,
  dictationAutoSend,
  dictationLanguage,
  dictationLanguageOptions,
  toggleSendWithEnter,
  toggleDictationClickToToggle,
  toggleDictationAutoSend,
  onDictationLanguageChange,
} = useInputPreferences()
const help = computed(() => ({
  sendWithEnter: t('When enabled, press Enter to send. When disabled, use Command+Enter to send.'),
  dictationClickToToggle: t('Use click-to-start and click-to-stop dictation instead of hold-to-talk.'),
  dictationAutoSend: t('Automatically send transcribed dictation when recording stops.'),
  dictationLanguage: t('Choose transcription language or keep auto-detect.'),
}))
</script>
