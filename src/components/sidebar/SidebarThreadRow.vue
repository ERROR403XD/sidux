<template>
  <li
    class="thread-row-item"
    :data-menu-open="row.menuOpen"
  >
    <SidebarMenuRow
      class="thread-row"
      :data-active="row.selected"
      :data-pinned="row.pinned"
      :data-menu-open="row.menuOpen"
      :force-right-hover="row.menuOpen"
      @click="$emit('select', row.thread.id)"
      @mouseleave="$emit('menu-leave', row.thread.id, $event)"
      @contextmenu="$emit('menu-context', $event, row.thread.id)"
    >
      <template #left>
        <span class="thread-left-stack">
          <span
            v-if="row.statusIndicator"
            class="thread-status-indicator"
            :data-state="row.statusIndicator.state"
            :title="row.statusIndicator.title"
          />
          <button
            class="thread-delete-button"
            type="button"
            :data-confirming="row.deleteConfirming"
            :title="row.deleteConfirming ? t('Confirm delete') : t('Delete thread')"
            @click.stop="$emit('delete', row.thread.id)"
          >
            <span v-if="row.deleteConfirming" class="thread-delete-confirm-label">{{ t('Confirm') }}</span>
            <IconTablerTrash v-else class="thread-icon" />
          </button>
        </span>
      </template>
      <button class="thread-main-button" type="button" @click.stop="$emit('select', row.thread.id)">
        <span class="thread-row-title-wrap">
          <span class="thread-row-title-line">
            <span class="thread-row-title">{{ row.thread.title }}</span>
            <IconTablerGitFork v-if="row.thread.hasWorktree" class="thread-row-worktree-icon" :title="t('Worktree thread')" />
            <span
              v-if="row.automationCount > 0"
              class="thread-row-automation-chip"
              :title="row.automationTitle"
            >
              <IconTablerBolt class="thread-row-automation-icon" />
              <span v-if="row.automationCount > 1" class="thread-row-automation-count">{{ row.automationCount }}</span>
            </span>
            <span
              v-if="row.goal"
              class="thread-row-automation-chip thread-row-goal-chip"
              :title="t(`持续目标 · ${t(goalStatusLabels[row.goal.status])}`)"
              :aria-label="t('持续目标')"
            >
              <IconTablerTarget class="thread-row-automation-icon" />
            </span>
            <span
              v-if="row.quotaResumeTitle"
              class="thread-row-automation-chip"
              :title="t(row.quotaResumeTitle)"
              :aria-label="t('额度恢复后继续')"
            >
              <IconTablerPlayerPlayRepeat class="thread-row-automation-icon" />
            </span>
            <span
              v-if="row.thread.pendingRequestState"
              class="thread-row-request-chip"
              :data-state="row.thread.pendingRequestState"
            >
              {{ row.requestLabel }}
            </span>
            <span v-if="row.scheduledResumeTitle" class="thread-row-automation-chip thread-row-scheduled-resume" :title="row.scheduledResumeTitle" :aria-label="t('定时续跑')">
              <IconTablerClock class="thread-row-automation-icon" />
            </span>
          </span>
        </span>
      </button>
      <template #right>
        <span class="thread-row-time">{{ row.relativeTime }}</span>
      </template>
      <template #right-hover>
        <div :ref="(element) => $emit('menu-ref', row.thread.id, element)" class="thread-menu-wrap">
          <button
            class="thread-menu-trigger"
            type="button"
            :title="t('Thread menu')"
            @click.stop="$emit('menu-toggle', row.thread.id)"
          >
            <IconTablerDots class="thread-icon" />
          </button>
        </div>
      </template>
    </SidebarMenuRow>
  </li>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import IconTablerClock from '../icons/IconTablerClock.vue'
import { goalStatusLabels, type ThreadGoal } from '../../api/threadCommands'
import { useUiLanguage } from '../../composables/useUiLanguage'
import type { UiThread } from '../../types/codex'
import IconTablerBolt from '../icons/IconTablerBolt.vue'
import IconTablerDots from '../icons/IconTablerDots.vue'
import IconTablerGitFork from '../icons/IconTablerGitFork.vue'
import IconTablerPlayerPlayRepeat from '../icons/IconTablerPlayerPlayRepeat.vue'
import IconTablerTarget from '../icons/IconTablerTarget.vue'
import IconTablerTrash from '../icons/IconTablerTrash.vue'
import SidebarMenuRow from './SidebarMenuRow.vue'

export type SidebarThreadRowModel = {
  thread: UiThread
  selected: boolean
  pinned: boolean
  menuOpen: boolean
  deleteConfirming: boolean
  statusIndicator: { state: 'awaiting-approval' | 'awaiting-response' | 'working' | 'unread' | 'background-completed' | 'idle' | 'error' | 'quota'; title?: string } | null
  automationCount: number
  automationTitle: string
  goal: ThreadGoal | null | undefined
  quotaResumeTitle: string
  scheduledResumeTitle?: string
  requestLabel: string
  relativeTime: string
}

defineProps<{ row: SidebarThreadRowModel }>()

defineEmits<{
  select: [threadId: string]
  delete: [threadId: string]
  'menu-toggle': [threadId: string]
  'menu-leave': [threadId: string, event?: MouseEvent]
  'menu-context': [event: MouseEvent, threadId: string]
  'menu-ref': [threadId: string, element: Element | ComponentPublicInstance | null]
}>()

const { t } = useUiLanguage()
</script>

<style scoped>
@reference "tailwindcss";

.thread-row-item {
  @apply m-0;
}

.thread-row-item[data-menu-open='true'] {
  @apply relative z-40;
}

.thread-row {
  @apply hover:bg-zinc-200;
}

.thread-row[data-menu-open='true'] {
  @apply relative z-30;
}

.thread-left-stack {
  @apply relative w-4 h-4 flex items-center justify-center;
}

.thread-delete-button {
  @apply absolute left-0 top-1/2 -translate-y-1/2 h-4 min-w-4 rounded text-zinc-500 opacity-0 pointer-events-none transition flex items-center justify-center;
}

.thread-delete-button[data-confirming='true'] {
  @apply z-10 h-5 min-w-16 px-1.5 bg-rose-600 text-white opacity-100 pointer-events-auto shadow-sm;
}

.thread-delete-confirm-label {
  @apply text-[11px] font-medium leading-none;
}

.thread-main-button {
  @apply min-w-0 w-full text-left rounded px-0 py-0 flex items-center min-h-5;
}

.thread-row-title-wrap {
  @apply min-w-0 inline-flex w-full items-center;
}

.thread-row-title-line {
  @apply min-w-0 inline-flex w-full items-center gap-1.5;
}

.thread-row-title {
  @apply min-w-0 block flex-1 text-sm leading-5 font-normal text-zinc-800 truncate whitespace-nowrap;
}

.thread-row-worktree-icon {
  @apply w-3 h-3 text-zinc-500 shrink-0;
}

.thread-row-request-chip {
  @apply inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none;
}

.thread-row-request-chip[data-state='approval'] {
  @apply border-emerald-500/20 bg-emerald-500/15 text-emerald-700;
}

.thread-row-request-chip[data-state='response'] {
  @apply border-sky-200 bg-sky-50 text-sky-700;
}

.thread-status-indicator {
  @apply w-2.5 h-2.5 rounded-full;
}

.thread-row-time {
  @apply block text-sm font-normal text-zinc-500;
}

.thread-menu-wrap {
  @apply relative;
}

.thread-menu-trigger {
  @apply h-4 w-4 rounded p-0 text-xs text-zinc-600 flex items-center justify-center;
}

.thread-icon {
  @apply w-4 h-4;
}

.thread-row[data-active='true'] {
  @apply bg-zinc-200;
}

.thread-row:hover .thread-delete-button,
.thread-row:focus-within .thread-delete-button,
.thread-delete-button[data-confirming='true'] {
  @apply opacity-100 pointer-events-auto;
}

.thread-status-indicator[data-state='unread'],
.thread-status-indicator[data-state='error'],
.thread-status-indicator[data-state='quota'] {
  width: 6.6667px;
  height: 6.6667px;
  @apply bg-blue-600;
}

.thread-status-indicator[data-state='working'] {
  @apply border-2 border-zinc-500 border-t-transparent bg-transparent animate-spin;
}

.thread-status-indicator[data-state='background-completed'] {
  width: 6.6667px;
  height: 6.6667px;
  @apply bg-emerald-500;
}

.thread-status-indicator[data-state='awaiting-approval'] {
  @apply bg-emerald-500;
}

.thread-status-indicator[data-state='awaiting-response'] {
  @apply bg-sky-500;
}

.thread-row:hover .thread-status-indicator[data-state='error'],
.thread-row:hover .thread-status-indicator[data-state='quota'],
.thread-row:focus-within .thread-status-indicator[data-state='error'],
.thread-row:focus-within .thread-status-indicator[data-state='quota'],
.thread-row:hover .thread-status-indicator[data-state='unread'],
.thread-row:hover .thread-status-indicator[data-state='working'],
.thread-row:hover .thread-status-indicator[data-state='awaiting-approval'],
.thread-row:hover .thread-status-indicator[data-state='awaiting-response'],
.thread-row:focus-within .thread-status-indicator[data-state='unread'],
.thread-row:focus-within .thread-status-indicator[data-state='working'],
.thread-row:focus-within .thread-status-indicator[data-state='awaiting-approval'],
.thread-row:focus-within .thread-status-indicator[data-state='awaiting-response'] {
  @apply opacity-0;
}
</style>
