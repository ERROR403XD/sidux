<template>
  <section
    class="file-change-summary-block"
    :class="{ 'file-change-summary-block-inline': inline }"
  >
    <button
      type="button"
      class="cmd-row cmd-row-group cmd-compact file-change-summary-row"
      :class="{ 'cmd-expanded': expanded }"
      @click="emit('toggle')"
    >
      <span class="cmd-chevron" :class="{ 'cmd-chevron-open': expanded }">▶</span>
      <span class="file-change-summary-label">
        {{ t(fileChangeSummaryLabel(summary)) }}
      </span>
      <span class="file-change-summary-status">
        <span
          v-for="part in fileChangeSummaryStatusParts(summary)"
          :key="`summary-status:${messageKey}:${part.tone}:${part.label}`"
          class="file-change-signed-count"
          :data-tone="part.tone"
        >
          {{ part.label }}
        </span>
      </span>
    </button>
    <div class="cmd-group-wrap" :class="{ 'cmd-group-visible': expanded }">
      <div class="file-change-panel-inner">
        <ul class="file-change-list">
          <li
            v-for="change in summary?.changes ?? []"
            :key="`file-change:${inline ? 'inline:' : ''}${messageKey}:${change.path}:${change.movedToPath || ''}`"
            class="file-change-item"
          >
            <span class="file-change-badge" :data-operation="fileChangeOperationTone(change)">
              {{ t(fileChangeOperationLabel(change)) }}
            </span>
            <button
              type="button"
              class="file-change-path-button"
              :title="change.path"
              @click="emit('showDiff', change)"
            >
              {{ displayFileChangePath(change.path, cwd) }}
            </button>
            <span v-if="change.movedToPath" class="file-change-arrow">→</span>
            <button
              v-if="change.movedToPath"
              type="button"
              class="file-change-path-button"
              :title="change.movedToPath"
              @click="emit('showDiff', change)"
            >
              {{ displayFileChangePath(change.movedToPath, cwd) }}
            </button>
            <span v-if="change.addedLineCount > 0 || change.removedLineCount > 0" class="file-change-delta">
              <span
                v-for="part in fileChangeDeltaParts(change)"
                :key="`change-delta:${inline ? 'inline:' : ''}${messageKey}:${change.path}:${part.tone}:${part.label}`"
                class="file-change-signed-count"
                :data-tone="part.tone"
              >
                {{ part.label }}
              </span>
            </span>
          </li>
        </ul>
        <div v-if="actionable" class="file-change-actions">
          <p v-if="actionError" class="file-change-action-error">
            {{ t(actionError) }}
          </p>
          <button
            type="button"
            class="file-change-action-button"
            :disabled="pending"
            :title="t(nextAction === 'redo' ? 'Redo file changes from this turn' : 'Undo file changes from this turn')"
            :aria-label="t(nextAction === 'redo' ? 'Redo file changes from this turn' : 'Undo file changes from this turn')"
            @click="emit('action', $event)"
          >
            <IconTablerArrowBackUp
              class="icon-svg file-change-action-icon"
              :class="{ 'file-change-action-icon-redo': nextAction === 'redo' }"
            />
            {{ t(actionLabel) }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UiFileChange } from '../../types/codex'
import type { TurnFileChangeSummary } from '../../composables/conversationFileChangeProjection'
import { displayFileChangePath, fileChangeDeltaParts, fileChangeOperationLabel, fileChangeOperationTone, fileChangeSummaryLabel, fileChangeSummaryStatusParts } from '../../composables/conversationFilePresentation'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerArrowBackUp from '../icons/IconTablerArrowBackUp.vue'

defineProps<{
  summary: TurnFileChangeSummary
  messageKey: string
  cwd: string
  inline?: boolean
  expanded: boolean
  actionable: boolean
  pending: boolean
  nextAction: 'undo' | 'redo'
  actionLabel: string
  actionError: string
}>()
const emit = defineEmits<{
  toggle: []
  showDiff: [change: UiFileChange]
  action: [event: MouseEvent]
}>()
const { t } = useUiLanguage()
</script>

<style scoped>
@reference "tailwindcss";

.icon-svg {
  @apply w-5 h-5;
}

.file-change-summary-block {
  @apply mt-3 flex flex-col gap-0;
}

.file-change-summary-block-inline {
  @apply mt-4;
}

.file-change-summary-row {
  @apply border-dashed;
}

.file-change-summary-label {
  @apply flex-1 min-w-0 truncate text-xs font-medium text-zinc-700;
}

.file-change-summary-status {
  @apply inline-flex max-w-28 items-center justify-end gap-1.5 text-right text-[11px] font-semibold text-zinc-500 flex-shrink-0;
}

.file-change-panel-inner {
  @apply mb-1 min-h-0 overflow-hidden pl-2;
}

.file-change-list {
  @apply m-0 flex list-none flex-col gap-0.5 rounded-xl border border-zinc-200 bg-white/80 p-1.5;
}

.file-change-item {
  @apply flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-zinc-700;
}

.file-change-path {
  @apply min-w-0 break-all font-mono text-[13px];
}

.file-change-path-button {
  @apply min-w-0 border-0 bg-transparent p-0 text-left font-mono text-[13px] text-[#0969da] hover:text-[#1f6feb] hover:underline underline-offset-2;
}

.file-change-arrow {
  @apply text-zinc-400;
}

.file-change-delta {
  @apply ml-auto inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-1 text-[11px] font-semibold text-zinc-600;
}

.file-change-actions {
  @apply mt-2 flex flex-wrap items-center justify-end gap-2;
}

.file-change-action-button {
  @apply inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-60;
}

.file-change-action-icon {
  @apply text-sm;
}

.file-change-action-icon-redo {
  transform: scaleX(-1);
}

.file-change-action-error {
  @apply m-0 min-w-0 flex-1 text-xs text-rose-600;
}

.file-change-signed-count {
  @apply inline-flex items-center whitespace-nowrap;
}

.file-change-signed-count[data-tone='add'] {
  @apply text-emerald-600;
}

.file-change-signed-count[data-tone='remove'] {
  @apply text-rose-600;
}

</style>
