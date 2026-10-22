<template>
  <div class="settings-form-grid">
    <div class="sidebar-settings-row sidebar-settings-row--select settings-field-short" :title="appearanceHelp">
      <span class="sidebar-settings-label">{{ t('主题') }}</span>
      <AppSelect
        :model-value="darkMode"
        :options="appearanceOptions"
        :aria-label="t('主题')"
        menu-align="end"
        @update:model-value="setDarkMode"
      />
    </div>
    <div class="sidebar-settings-row sidebar-settings-row--select settings-field-short" :title="chatWidthHelp">
      <span class="sidebar-settings-label">{{ t('Chat width') }}</span>
      <AppSelect
        :model-value="chatWidth"
        :options="chatWidthOptions"
        :aria-label="t('Chat width')"
        menu-align="end"
        @update:model-value="setChatWidth"
      />
    </div>
    <WebUiBrandingSettings />
  </div>
</template>

<script setup lang="ts">
import AppSelect from '../common/AppSelect.vue'
import WebUiBrandingSettings from './WebUiBrandingSettings.vue'
import { useAppearancePreferences } from '../../composables/useAppearancePreferences'
import { useUiLanguage } from '../../composables/useUiLanguage'

const { t } = useUiLanguage()
const { darkMode, chatWidth, appearanceOptions, chatWidthOptions, setDarkMode, setChatWidth } = useAppearancePreferences()
const appearanceHelp = t('Switch between system theme, light mode, and dark mode.')
const chatWidthHelp = t('Choose how wide the conversation column and composer can grow on desktop screens.')
</script>
