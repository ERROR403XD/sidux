<template>
  <Teleport to="body">
    <div class="operation-toast-host" aria-live="polite" aria-relevant="additions">
      <TransitionGroup name="operation-toast">
        <div v-for="item in operationToasts" :key="item.id" class="operation-toast" :class="`is-${item.kind}`"
          role="status" @mouseenter="pauseOperationToast(item.id)" @mouseleave="resumeUnlessFocused($event, item.id)"
          @focusin="pauseOperationToast(item.id)" @focusout="resumeUnlessHovered($event, item.id)">
          <span class="operation-toast-progress" aria-hidden="true" :style="{ animationDuration: `${item.duration}ms`, animationPlayState: item.paused ? 'paused' : 'running' }" />
          <span class="operation-toast-icon" aria-hidden="true">{{ item.kind === 'success' ? '✓' : '!' }}</span>
          <span class="operation-toast-message">{{ t(item.message) }}</span>
          <button type="button" :aria-label="t('关闭提示')" @click="dismissOperationToast(item.id)">×</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { t } from '../../composables/useUiLanguage'
import { operationToasts, clearOperationToasts, dismissOperationToast, pauseOperationToast, resumeOperationToast } from '../../composables/useOperationToast'
function resumeUnlessFocused(event: MouseEvent, id: number): void {
  if (!(event.currentTarget as HTMLElement).contains(document.activeElement)) resumeOperationToast(id)
}
function resumeUnlessHovered(event: FocusEvent, id: number): void {
  const element = event.currentTarget as HTMLElement
  if (!element.contains(event.relatedTarget as Node | null) && !element.matches(':hover')) resumeOperationToast(id)
}
onBeforeUnmount(() => clearOperationToasts())
</script>
