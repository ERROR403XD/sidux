<template>
  <div class="diff-viewer-backdrop" @click="emit('close')">
    <div class="diff-viewer-shell" @click.stop>
      <aside v-if="!isMobile" class="diff-viewer-sidebar">
        <div class="diff-viewer-sidebar-header">
          <p class="diff-viewer-sidebar-title">Changed files</p>
          <p class="diff-viewer-sidebar-count">{{ formatFileChangeCountLabel(diffViewerChanges.length) }}</p>
        </div>
        <div class="diff-viewer-sidebar-list">
          <button
            v-for="change in diffViewerChanges"
            :key="`diff-viewer:${fileChangeKey(change)}`"
            type="button"
            class="diff-viewer-file-button"
            :data-active="fileChangeKey(change) === fileChangeKey(activeDiffViewerChange)"
            @click="emit('select', change, isMobile)"
          >
            <span class="file-change-badge" :data-operation="fileChangeOperationTone(change)">
              {{ t(fileChangeOperationLabel(change)) }}
            </span>
            <span class="diff-viewer-file-label">
              {{ displayFileChangePath(change.path, cwd) }}
              <template v-if="change.movedToPath"> → {{ displayFileChangePath(change.movedToPath, cwd) }}</template>
            </span>
            <span v-if="formatFileChangeDelta(change)" class="diff-viewer-file-delta">{{ formatFileChangeDelta(change) }}</span>
          </button>
        </div>
      </aside>

      <section class="diff-viewer-main">
        <div class="diff-viewer-toolbar">
          <div class="diff-viewer-title-wrap">
            <p class="diff-viewer-title">
              {{ displayFileChangePath(activeDiffViewerChange.path, cwd) }}
              <template v-if="activeDiffViewerChange.movedToPath"> → {{ displayFileChangePath(activeDiffViewerChange.movedToPath, cwd) }}</template>
            </p>
            <p class="diff-viewer-subtitle">
              {{ t(fileChangeOperationLabel(activeDiffViewerChange)) }}
              <span v-if="formatFileChangeDelta(activeDiffViewerChange)"> · {{ formatFileChangeDelta(activeDiffViewerChange) }}</span>
            </p>
          </div>
          <div class="diff-viewer-toolbar-actions">
            <button
              v-if="isMobile"
              type="button"
              class="diff-viewer-mobile-files-button"
              @click="emit('toggleFileList')"
            >
              {{ formatFileChangeCountLabel(diffViewerChanges.length) }}
            </button>
            <button class="image-modal-close diff-viewer-close" type="button" aria-label="Close diff viewer" @click="emit('close')">
              <IconTablerX class="icon-svg" />
            </button>
          </div>
        </div>

        <div v-if="!hasDiffViewerContent(activeDiffViewerChange)" class="diff-viewer-empty">
          <p class="diff-viewer-empty-title">No diff available</p>
          <p class="diff-viewer-empty-text">This summary was restored from the final answer text, but the thread history does not include patch diff content for this file.</p>
        </div>

        <div v-else class="diff-viewer-panel">
          <div class="diff-viewer-meta">
            <span class="diff-viewer-language">{{ inferDiffViewerLanguage(activeDiffViewerChange) || 'diff' }}</span>
          </div>
          <div class="diff-viewer-lines">
            <div
              v-for="line in activeDiffViewerLines"
              :key="line.key"
              class="diff-viewer-line"
              :data-kind="line.kind"
            >
              <span class="diff-viewer-line-number">{{ line.oldLine ?? '' }}</span>
              <span class="diff-viewer-line-number">{{ line.newLine ?? '' }}</span>
              <span class="diff-viewer-line-marker">{{ diffViewerMarker(line) }}</span>
              <code class="diff-viewer-line-code" v-html="escapeHtml(line.text) || '&nbsp;'"></code>
            </div>
          </div>
        </div>
      </section>

      <Transition name="diff-viewer-sheet">
        <div
          v-if="isMobile && isDiffViewerFileListOpen"
          class="diff-viewer-mobile-sheet-backdrop"
          @click="emit('closeFileList')"
        >
          <div class="diff-viewer-mobile-sheet" @click.stop>
            <div class="diff-viewer-mobile-sheet-handle" aria-hidden="true"></div>
            <div class="diff-viewer-mobile-sheet-header">
              <p class="diff-viewer-sidebar-title">Changed files</p>
              <p class="diff-viewer-sidebar-count">{{ formatFileChangeCountLabel(diffViewerChanges.length) }}</p>
            </div>
            <div class="diff-viewer-mobile-sheet-list">
              <button
                v-for="change in diffViewerChanges"
                :key="`diff-viewer-sheet:${fileChangeKey(change)}`"
                type="button"
                class="diff-viewer-file-button"
                :data-active="fileChangeKey(change) === fileChangeKey(activeDiffViewerChange)"
                @click="emit('select', change, isMobile)"
              >
                <span class="file-change-badge" :data-operation="fileChangeOperationTone(change)">
                  {{ t(fileChangeOperationLabel(change)) }}
                </span>
                <span class="diff-viewer-file-label">
                  {{ displayFileChangePath(change.path, cwd) }}
                  <template v-if="change.movedToPath"> → {{ displayFileChangePath(change.movedToPath, cwd) }}</template>
                </span>
                <span v-if="formatFileChangeDelta(change)" class="diff-viewer-file-delta">{{ formatFileChangeDelta(change) }}</span>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { UiFileChange } from '../../types/codex'
import { buildDiffViewerLines, diffViewerMarker, displayFileChangePath, fileChangeKey, fileChangeOperationLabel, fileChangeOperationTone, formatFileChangeCountLabel, formatFileChangeDelta, hasDiffViewerContent, inferDiffViewerLanguage } from '../../composables/conversationFilePresentation'
import { escapeHtml } from '../../composables/conversationRenderPrimitives'
import { useMobile } from '../../composables/useMobile'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerX from '../icons/IconTablerX.vue'

const props = defineProps<{
  diffViewerChanges: readonly UiFileChange[]
  activeDiffViewerChange: UiFileChange
  isDiffViewerFileListOpen: boolean
  cwd: string
}>()
const emit = defineEmits<{
  close: []
  toggleFileList: []
  closeFileList: []
  select: [change: UiFileChange, isMobile: boolean]
}>()
const { isMobile } = useMobile()
const { t } = useUiLanguage()
const activeDiffViewerLines = computed(() => buildDiffViewerLines(props.activeDiffViewerChange))
</script>

<style scoped>
@reference "tailwindcss";

.icon-svg {
  @apply w-5 h-5;
}

.image-modal-close {
  @apply absolute top-2 right-2 z-10 w-10 h-10 rounded-full bg-white/90 text-slate-900 border border-slate-300 flex items-center justify-center;
}

.diff-viewer-backdrop {
  @apply fixed inset-0 bg-black/45 p-3 sm:p-6 flex items-center justify-center;
  z-index: var(--ui-layer-dialog);
}

.diff-viewer-shell {
  @apply relative grid h-[min(88vh,920px)] w-[min(96vw,1320px)] grid-cols-1 overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-2xl lg:grid-cols-[320px_minmax(0,1fr)];
}

.diff-viewer-sidebar {
  @apply flex min-h-0 flex-col border-b border-zinc-200 bg-zinc-50 lg:border-b-0 lg:border-r;
}

.diff-viewer-sidebar-header {
  @apply flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-4;
}

.diff-viewer-sidebar-title {
  @apply m-0 text-sm font-semibold text-zinc-900;
}

.diff-viewer-sidebar-count {
  @apply m-0 text-xs font-medium text-zinc-500;
}

.diff-viewer-sidebar-list {
  @apply flex min-h-0 flex-col gap-2 overflow-y-auto p-3;
}

.diff-viewer-file-button {
  @apply flex w-full flex-col items-start gap-2 rounded-2xl border border-transparent bg-transparent px-3 py-3 text-left transition hover:border-zinc-200 hover:bg-white;
}

.diff-viewer-file-button[data-active='true'] {
  @apply border-sky-200 bg-white shadow-sm;
}

.diff-viewer-file-label {
  @apply break-all font-mono text-[13px] text-zinc-700;
}

.diff-viewer-file-delta {
  @apply inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-600;
}

.diff-viewer-main {
  @apply flex min-h-0 flex-col bg-white;
}

.diff-viewer-toolbar {
  @apply flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4;
}

.diff-viewer-toolbar-actions {
  @apply flex items-center gap-2 shrink-0;
}

.diff-viewer-title-wrap {
  @apply min-w-0;
}

.diff-viewer-title {
  @apply m-0 break-all text-base font-semibold text-zinc-900;
}

.diff-viewer-subtitle {
  @apply mt-1 mb-0 text-sm text-zinc-500;
}

.diff-viewer-close {
  @apply static shrink-0 border-zinc-200 bg-zinc-100 text-zinc-700;
}

.diff-viewer-mobile-files-button {
  @apply inline-flex items-center rounded-full border border-zinc-200 bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-700;
}

.diff-viewer-empty {
  @apply flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center;
}

.diff-viewer-empty-title {
  @apply m-0 text-base font-semibold text-zinc-900;
}

.diff-viewer-empty-text {
  @apply mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500;
}

.diff-viewer-panel {
  @apply flex min-h-0 flex-1 flex-col;
}

.diff-viewer-meta {
  @apply border-b border-zinc-200 bg-zinc-50 px-5 py-2;
}

.diff-viewer-language {
  @apply inline-flex items-center rounded-full bg-zinc-200 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-700;
}

.diff-viewer-lines {
  @apply min-h-0 flex-1 overflow-auto bg-zinc-950;
}

.diff-viewer-line {
  display: grid;
  grid-template-columns: 4rem 4rem 2rem minmax(0, 1fr);
  align-items: stretch;
  min-width: fit-content;
}

.diff-viewer-line-number {
  @apply border-r border-zinc-800 px-3 py-1.5 text-right font-mono text-xs text-zinc-500 select-none;
}

.diff-viewer-line-marker {
  @apply border-r border-zinc-800 px-2 py-1.5 text-center font-mono text-xs text-zinc-500 select-none;
}

.diff-viewer-line-code {
  @apply block whitespace-pre px-3 py-1.5 font-mono text-[12px] leading-5 text-zinc-100;
}

.diff-viewer-line[data-kind='meta'] {
  @apply bg-zinc-900;
}

.diff-viewer-line[data-kind='meta'] .diff-viewer-line-code,
.diff-viewer-line[data-kind='meta'] .diff-viewer-line-marker {
  @apply text-sky-300;
}

.diff-viewer-line[data-kind='hunk'] {
  @apply bg-sky-950/40;
}

.diff-viewer-line[data-kind='hunk'] .diff-viewer-line-code,
.diff-viewer-line[data-kind='hunk'] .diff-viewer-line-marker {
  @apply text-sky-300;
}

.diff-viewer-line[data-kind='add'] {
  background: rgba(20, 83, 45, 0.38);
}

.diff-viewer-line[data-kind='add'] .diff-viewer-line-marker,
.diff-viewer-line[data-kind='add'] .diff-viewer-line-code {
  @apply text-emerald-200;
}

.diff-viewer-line[data-kind='remove'] {
  background: rgba(127, 29, 29, 0.32);
}

.diff-viewer-line[data-kind='remove'] .diff-viewer-line-marker,
.diff-viewer-line[data-kind='remove'] .diff-viewer-line-code {
  @apply text-rose-200;
}

.diff-viewer-line[data-kind='context'] {
  @apply bg-zinc-950;
}

.diff-viewer-line[data-kind='context'] .diff-viewer-line-code {
  @apply text-zinc-100;
}

.diff-viewer-mobile-sheet-backdrop {
  @apply absolute inset-0 z-20 bg-black/35 flex items-end;
}

.diff-viewer-mobile-sheet {
  @apply w-full max-h-[70vh] rounded-t-3xl bg-white shadow-2xl border-t border-zinc-200 flex flex-col overflow-hidden;
}

.diff-viewer-mobile-sheet-handle {
  @apply mx-auto mt-3 h-1.5 w-12 rounded-full bg-zinc-300;
}

.diff-viewer-mobile-sheet-header {
  @apply flex items-center justify-between gap-3 px-4 pt-3 pb-2 border-b border-zinc-200;
}

.diff-viewer-mobile-sheet-list {
  @apply flex min-h-0 flex-col gap-2 overflow-y-auto px-3 py-3;
}

.diff-viewer-sheet-enter-active,
.diff-viewer-sheet-leave-active {
  @apply transition-opacity duration-200;
}

.diff-viewer-sheet-enter-active .diff-viewer-mobile-sheet,
.diff-viewer-sheet-leave-active .diff-viewer-mobile-sheet {
  transition: transform 200ms ease;
}

.diff-viewer-sheet-enter-from,
.diff-viewer-sheet-leave-to {
  @apply opacity-0;
}

.diff-viewer-sheet-enter-from .diff-viewer-mobile-sheet,
.diff-viewer-sheet-leave-to .diff-viewer-mobile-sheet {
  transform: translateY(100%);
}

@media (max-width: 767px) {
  .diff-viewer-backdrop {
    @apply p-0 items-stretch;
  }

  .diff-viewer-shell {
    @apply h-[100dvh] w-screen rounded-none border-0 shadow-none;
  }

  .diff-viewer-main {
    @apply min-w-0;
  }

  .diff-viewer-toolbar {
    @apply sticky top-0 z-10 bg-white px-3 py-3;
  }

  .diff-viewer-title {
    @apply text-sm leading-5;
  }

  .diff-viewer-subtitle {
    @apply text-xs;
  }

  .diff-viewer-meta {
    @apply px-3 py-2;
  }

  .diff-viewer-language {
    @apply text-[10px];
  }

  .diff-viewer-line {
    grid-template-columns: 2.75rem 2.75rem 1.5rem minmax(0, 1fr);
  }

  .diff-viewer-line-number {
    @apply px-1.5 py-1 text-[10px];
  }

  .diff-viewer-line-marker {
    @apply px-1 py-1 text-[10px];
  }

  .diff-viewer-line-code {
    @apply px-2 py-1 text-[11px] leading-5;
  }
}
</style>
