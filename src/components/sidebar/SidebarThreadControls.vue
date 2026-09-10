<template>
  <div class="sidebar-thread-controls">
    <button
      class="sidebar-thread-controls-button"
      type="button"
      :aria-label="isSidebarCollapsed ? t('Expand sidebar') : t('Collapse sidebar')"
      :title="isSidebarCollapsed ? t('Expand sidebar') : t('Collapse sidebar')"
      @click="$emit('toggle-sidebar')"
    >
      <IconTablerLayoutSidebarFilled v-if="isSidebarCollapsed" class="sidebar-thread-controls-icon" />
      <IconTablerLayoutSidebar v-else class="sidebar-thread-controls-icon" />
    </button>

    <template v-if="!isSidebarCollapsed">
    <button class="sidebar-thread-controls-button" type="button" :title="t(`主题：${t(theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统')}`)" :aria-label="t(`主题：${t(theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统')}`)" @click="$emit('cycle-theme')">
      <svg class="sidebar-thread-controls-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
        <path v-if="theme === 'dark'" d="M20 15.2A8 8 0 0 1 8.8 4 8 8 0 1 0 20 15.2Z" />
        <template v-else-if="theme === 'light'"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></template>
        <template v-else>
          <circle cx="7" cy="7" r="2.5" />
          <path d="M7 1v1m0 10v1M1 7h1m10 0h1M2.8 2.8l.7.7m7 7l.7.7M2.8 11.2l.7-.7m7-7l.7-.7M18 3L6 21M22 17.5a5 5 0 0 1-6.5-6.5 5 5 0 1 0 6.5 6.5Z" />
        </template>
      </svg>
    </button>
    <button class="sidebar-thread-controls-button" :class="{ 'is-active': settingsActive }" type="button" :aria-label="t('Settings')" :aria-pressed="settingsActive" @click="$emit('open-settings')"><IconTablerSettings class="sidebar-thread-controls-icon" /></button>
    <slot />
    </template>

    <button
      v-if="showNewThreadButton"
      class="sidebar-thread-controls-button"
      type="button"
      :aria-label="t('Start new thread')"
      :title="t('Start new thread')"
      @click="$emit('start-new-thread')"
    >
      <IconTablerFilePencil class="sidebar-thread-controls-icon" />
    </button>
  </div>
</template>

<script setup lang="ts">
import IconTablerSettings from '../icons/IconTablerSettings.vue'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerLayoutSidebar from '../icons/IconTablerLayoutSidebar.vue'
import IconTablerLayoutSidebarFilled from '../icons/IconTablerLayoutSidebarFilled.vue'

defineProps<{
  isSidebarCollapsed: boolean
  showNewThreadButton?: boolean
  theme?: string
  settingsActive?: boolean
}>()

defineEmits<{
  'cycle-theme': []
  'open-settings': []
  'toggle-sidebar': []
  'start-new-thread': []
}>()

const { t } = useUiLanguage()
</script>

<style scoped>
@reference "tailwindcss";

.sidebar-thread-controls {
  @apply flex flex-row flex-nowrap items-center gap-2;
}

.sidebar-thread-controls-button {
  @apply h-6.75 w-6.75 rounded-md border border-transparent bg-transparent text-zinc-600 flex items-center justify-center transition hover:border-zinc-200 hover:bg-zinc-50;
}

.sidebar-thread-controls-icon {
  @apply w-4 h-4;
}
</style>
