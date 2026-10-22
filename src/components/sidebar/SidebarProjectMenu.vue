<template>
  <div class="project-hover-controls" @keydown="onMenuKeydown">
    <div ref="menuWrapRef" class="project-menu-wrap">
      <button
        ref="menuTriggerRef"
        class="project-menu-trigger"
        type="button"
        :title="t('Project menu')"
        @click.stop="$emit('toggle', projectName)"
      >
        <IconTablerDots class="thread-icon" />
      </button>

      <AppPopover
        :open="open"
        :anchor="menuWrapRef"
        :anchor-point="contextPoint"
        :width="176"
        :direction="direction"
        align="end"
        panel-class="project-menu-panel"
        @close="$emit('close')"
      >
        <div ref="menuPanelRef" class="project-menu-content" @click.stop>
          <button class="project-menu-item" type="button" @click="$emit('mark-read', projectName)">
            {{ t('全部标为已读') }}
          </button>
          <button class="project-menu-item" type="button" @click="$emit('browse-files', projectName)">
            {{ t('Browse files') }}
          </button>
          <button class="project-menu-item" type="button" @click="$emit('save-project', projectName)">
            {{ t('Export Project') }}
          </button>
          <button class="project-menu-item" type="button" @click="openAutomations">
            {{ hasAutomations ? t('Manage automations…') : t('Add automation…') }}
          </button>
          <button
            v-if="hasGitRepo"
            class="project-menu-item"
            type="button"
            @click="$emit('create-worktree', projectName)"
          >
            {{ t('New worktree') }}
          </button>
          <button class="project-menu-item" type="button" @click="editProject">
            {{ t('编辑项目') }}
          </button>
          <button
            class="project-menu-item project-menu-item-danger"
            type="button"
            @click="removeProject"
          >
            {{ t('Remove') }}
          </button>
        </div>
      </AppPopover>
    </div>

    <button
      class="thread-start-button"
      type="button"
      :aria-label="newThreadLabel"
      :title="newThreadLabel"
      @click.stop="$emit('start-new-thread', projectName)"
    >
      <IconTablerFilePencil class="thread-icon" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppPopover from '../common/AppPopover.vue'
import type { ProjectMenuHandle } from './projectMenuHandle'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerDots from '../icons/IconTablerDots.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'

const props = defineProps<{
  projectName: string
  open: boolean
  contextPoint?: { x: number; y: number } | null
  direction: 'up' | 'down'
  hasAutomations: boolean
  hasGitRepo: boolean
  newThreadLabel: string
}>()

const emit = defineEmits<{
  close: []
  toggle: [projectName: string]
  'menu-ref': [projectName: string, handle: ProjectMenuHandle | null]
  'browse-files': [projectName: string]
  'save-project': [projectName: string]
  'mark-read': [projectName: string]
  'manage-automations': [projectName: string]
  'create-worktree': [projectName: string]
  rename: [projectName: string]
  remove: [projectName: string]
  'start-new-thread': [projectName: string]
}>()

const { t } = useUiLanguage()
const menuWrapRef = ref<HTMLElement | null>(null)
const menuPanelRef = ref<HTMLElement | null>(null)
const menuTriggerRef = ref<HTMLButtonElement | null>(null)

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open) return
  event.preventDefault()
  event.stopPropagation()
  menuTriggerRef.value?.focus({ preventScroll: true })
  emit('toggle', props.projectName)
}

// The action row disappears when opening a dialog. Preserve a connected
// return target for the dialog's shared focus restoration.
function openAutomations(): void {
  menuTriggerRef.value?.focus({ preventScroll: true })
  emit('manage-automations', props.projectName)
}

function editProject(): void {
  menuTriggerRef.value?.focus({ preventScroll: true })
  emit('rename', props.projectName)
}

function removeProject(): void {
  menuTriggerRef.value?.focus({ preventScroll: true })
  emit('remove', props.projectName)
}

onMounted(() => {
  if (!menuWrapRef.value) return
  emit('menu-ref', props.projectName, {
    element: menuWrapRef.value,
    getPanelHeight: () => menuPanelRef.value?.getBoundingClientRect().height ?? 0,
  })
})

onBeforeUnmount(() => {
  emit('menu-ref', props.projectName, null)
})
</script>

<style scoped>
@reference "tailwindcss";

.project-hover-controls {
  @apply flex items-center gap-1;
}

.project-menu-wrap {
  @apply relative;
}

.project-menu-trigger {
  @apply h-4 w-4 rounded p-0 text-xs text-zinc-600 flex items-center justify-center;
}

.project-menu-content {
  @apply p-1 flex flex-col gap-0.5;
}

.project-menu-item {
  @apply rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100;
}

.project-menu-item-danger {
  @apply text-rose-700 hover:bg-rose-50;
}

.thread-icon {
  @apply w-4 h-4;
}
</style>
