<template>
  <Teleport to="body">
    <div ref="root" class="composer-command-picker" :style="placement" @pointerdown.prevent>
      <div class="composer-command-heading"><span>{{ t('命令') }}</span><span>/</span></div>
      <div :id="listId" ref="optionsRoot" class="composer-command-options" role="listbox" @scroll="onScroll" :aria-label="t('斜杠命令')">
        <div :style="{ height: `${windowStart * rowHeight}px` }" aria-hidden="true"></div>
        <button v-for="({ command, index }) in windowCommands" :id="`${listId}-${index}`" :key="command.id" class="composer-command-option" :class="{ 'is-selected': index === selectedIndex }" role="option" :aria-selected="index === selectedIndex" :aria-setsize="commands.length" :aria-posinset="index + 1" type="button" tabindex="-1" @click="emit('choose', command)">
          <span class="composer-command-text"><strong>{{ command.name }}</strong><span>{{ command.description }}</span></span>
          <small>{{ t(command.group) }}</small>
        </button>
        <div :style="{ height: `${Math.max(0, commands.length - windowStart - windowCommands.length) * rowHeight}px` }" aria-hidden="true"></div>
        <div v-if="!commands.length" class="composer-command-empty">{{ t('没有匹配命令，继续输入或按原方式发送') }}</div>
      </div>
      <div class="composer-command-footer">{{ t('↑↓ 选择 · Enter 确认 · Esc 收起') }}<span>{{ t('也可直接输入文字') }}</span></div>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { t } from '../../composables/useUiLanguage'

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComposerCommand } from './composerCommands'
const props = defineProps<{ commands: ComposerCommand[]; selectedIndex: number; anchor: HTMLTextAreaElement | null; listId: string }>()
const emit = defineEmits<{ choose: [command: ComposerCommand]; dismiss: [] }>()
const root = ref<HTMLElement | null>(null)
const optionsRoot = ref<HTMLElement | null>(null)
const rowHeight = 52
const windowStart = ref(0)
const windowCommands = computed(() => props.commands.slice(windowStart.value, windowStart.value + 12).map((command, index) => ({ command, index: index + windowStart.value })))
function onScroll() { windowStart.value = Math.max(0, Math.floor((optionsRoot.value?.scrollTop ?? 0) / rowHeight) - 2) }
const placement = ref<Record<string, string>>({ visibility: 'hidden' })
function position() {
  if (!props.anchor || !root.value) return
  const rect = props.anchor.getBoundingClientRect()
  const viewport = window.visualViewport
  const top = viewport?.offsetTop ?? 0, height = viewport?.height ?? window.innerHeight
  const width = Math.min(380, window.innerWidth - 16)
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
  const above = rect.top - top - 8, below = top + height - rect.bottom - 8
  const useAbove = above >= Math.min(320, height * .4) || above >= below
  const available = Math.max(90, Math.min(height * .4, useAbove ? above : below))
  placement.value = { left: `${left}px`, width: `${width}px`, maxHeight: `${available}px`, top: useAbove ? 'auto' : `${rect.bottom + 6}px`, bottom: useAbove ? `${window.innerHeight - rect.top + 6}px` : 'auto' }
}
function outside(event: PointerEvent) { if (!root.value?.contains(event.target as Node) && event.target !== props.anchor) emit('dismiss') }
watch(() => props.selectedIndex, (index) => {
  const list = optionsRoot.value
  if (!list || index < 0) return
  const top = index * rowHeight
  if (top < list.scrollTop) list.scrollTop = top
  else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight
  onScroll()
})
watch(() => props.commands, () => { windowStart.value = 0; if (optionsRoot.value) optionsRoot.value.scrollTop = 0; void nextTick(position) })
onMounted(() => { position(); window.addEventListener('resize', position); window.addEventListener('scroll', position, true); window.visualViewport?.addEventListener('resize', position); document.addEventListener('pointerdown', outside) })
onBeforeUnmount(() => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); window.visualViewport?.removeEventListener('resize', position); document.removeEventListener('pointerdown', outside) })
</script>
