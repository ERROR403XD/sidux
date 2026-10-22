<template>
  <section class="conversation-root" @contextmenu.capture="onConversationContextMenu">
    <p v-if="isLoading && messages.length === 0" class="conversation-loading">Loading messages...</p>

    <p
      v-else-if="messages.length === 0 && pendingRequests.length === 0 && !liveOverlay && !hasMoreAbove"
      class="conversation-empty"
    >
      No messages in this thread yet.
    </p>

    <ul v-else ref="conversationListRef" class="conversation-list" @scroll="onConversationScroll">
      <li v-if="hasMoreAbove" class="conversation-load-more">
        <button
          type="button"
          class="load-more-button"
          :disabled="isLoadingMore || isLoadingPersistedAbove"
          @click="loadMoreAbove"
        >
          {{ isLoadingMore || isLoadingPersistedAbove ? 'Loading…' : 'Load earlier messages' }}
        </button>
        <p v-if="historyLoadError" class="history-load-error" role="alert">{{ t(historyLoadError) }}</p>
      </li>
      <template v-for="message in visibleMessages" :key="renderKey(message)">
      <li
        v-if="!hiddenGroupedCommandIds.has(renderKey(message)) && !hiddenFileChangeMessageIds.has(renderKey(message))"
        class="conversation-item"
        :data-role="message.role"
        :data-message-type="message.messageType || ''"
      >
        <ConversationCommandResults
          v-if="isCommandMessage(message)"
          :message="message"
          :presentation="commandResults"
        />

        <div
          v-else-if="isFileChangeMessage(message)"
          class="message-row"
          :data-role="message.role"
          :data-message-type="message.messageType || ''"
        >
          <div class="message-stack" :data-role="message.role">
            <article class="message-body" :data-role="message.role">
              <ConversationFileChangeSummary
                v-if="readStandaloneFileChangeSummary(message)"
                :summary="readStandaloneFileChangeSummary(message)!"
                :message-key="renderKey(message)"
                :cwd="cwd"
                :expanded="isFileChangeSummaryExpanded(renderKey(message))"
                :actionable="isFileChangeActionable(readStandaloneFileChangeSummary(message))"
                :pending="isFileChangeActionPending()"
                :next-action="fileChangeNextAction(readStandaloneFileChangeSummary(message))"
                :action-label="fileChangeActionLabel(readStandaloneFileChangeSummary(message))"
                :action-error="fileChangeActionErrorText(readStandaloneFileChangeSummary(message))"
                @toggle="toggleFileChangeSummary(renderKey(message))"
                @show-diff="openDiffViewer(readStandaloneFileChangeSummary(message), $event)"
                @action="onFileChangeActionClick($event, readStandaloneFileChangeSummary(message))"
              />
            </article>
          </div>
        </div>

        <div v-else class="message-row" :data-role="message.role" :data-message-type="message.messageType || ''">
          <div class="message-stack" :data-role="message.role">
            <article class="message-body" :data-role="message.role">
              <ul
                v-if="message.images && message.images.length > 0"
                class="message-image-list"
                :class="{ 'message-generated-image-list': message.messageType === 'imageView' }"
                :data-role="message.role"
              >
                <li v-for="imageUrl in message.images" :key="imageUrl" class="message-image-item">
                  <button class="message-image-button" type="button" @click="openImageModal(imageUrl)">
                    <img
                      class="message-image-preview"
                      :class="{ 'message-generated-image-preview': message.messageType === 'imageView' }"
                      :src="imageUrl"
                      :alt="message.messageType === 'imageView' ? 'Generated image' : 'Message image preview'"
                      loading="lazy"
                    />
                  </button>
                </li>
              </ul>

              <div v-if="message.fileAttachments && message.fileAttachments.length > 0" class="message-file-attachments">
                <span v-for="att in message.fileAttachments" :key="`${renderKey(message)}:${att.path}`" class="message-file-chip">
                  <span class="message-file-chip-icon">📄</span>
                  <a
                    class="message-file-link message-file-chip-name"
                    :href="toBrowseUrl(att.path)"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="att.path"
                  >
                    {{ att.label }}
                  </a>
                </span>
              </div>

              <div v-if="message.skills && message.skills.length > 0" class="message-skill-attachments">
                <a
                  v-for="skill in message.skills"
                  :key="`${renderKey(message)}:${skill.path}`"
                  class="message-skill-chip"
                  :href="toBrowseUrl(skill.path)"
                  :title="skill.path"
                >
                  <span class="message-skill-chip-prefix">Skill</span>
                  <span class="message-skill-chip-name">{{ skill.name }}</span>
                </a>
              </div>

              <article v-if="message.text.length > 0" class="message-card" :data-role="message.role">
                <div v-if="message.isAutomationRun" class="automation-message-label">
                  <span>Sent via automation</span>
                  <code v-if="message.automationDisplayName">{{ message.automationDisplayName }}</code>
                  <time v-if="message.automationRun" :datetime="new Date(message.automationRun.startedAt).toISOString()" :title="formatLocalDateTime(message.automationRun.startedAt, { second: '2-digit' })">{{ formatLocalDateTime(message.automationRun.startedAt) }}</time>
                </div>
                <SubtaskEventCard v-if="message.subtask" :event="message.subtask" @open-task="emit('openTask', $event)" />
                <div v-else-if="message.compaction" class="thread-compaction-event" :data-status="message.compaction.status" role="status">
                  <span>{{ t(message.text) }}</span>
                  <small v-if="message.compaction.durationMs != null">{{ (message.compaction.durationMs / 1000).toFixed(1) }} {{ t('秒') }}</small>
                  <p v-if="message.compaction.error" role="alert">{{ t(message.compaction.error) }}</p>
                </div>
                <details v-else-if="message.isUnhandled" class="model-tool-summary"><summary>{{ message.text }}</summary><p>{{ message.rawPayload }}</p></details>
                <ConversationWorkedResults
                  v-else-if="message.messageType === 'worked'"
                  :message="message"
                  :commands="isWorkedExpanded(message) ? getCommandsForWorked(messages, messages.indexOf(message)) : []"
                  :presentation="commandResults"
                />
                <div v-else-if="isPlanMessage(message)" class="plan-card" :data-streaming="message.messageType === 'plan.live'">
                  <div class="plan-card-header">
                    <p class="plan-card-title">Plan</p>
                    <span v-if="message.messageType === 'plan.live'" class="plan-card-badge">Updating</span>
                  </div>
                  <div
                    v-if="readPlanExplanation(message)"
                    class="plan-card-explanation plan-card-markdown"
                    v-html="renderMarkdownBlocksAsHtml(readPlanExplanation(message))"
                  />
                  <ol v-if="readPlanSteps(message).length > 0" class="plan-step-list">
                    <li
                      v-for="(step, stepIndex) in readPlanSteps(message)"
                      :key="`${renderKey(message)}:plan-step:${stepIndex}`"
                      class="plan-step-item"
                      :data-status="step.status"
                    >
                      <span class="plan-step-status" :data-status="step.status">{{ planStepStatusIcon(step.status) }}</span>
                      <div class="plan-step-text plan-card-markdown" v-html="renderMarkdownBlocksAsHtml(step.step)" />
                    </li>
                  </ol>
                  <div v-else class="plan-card-markdown" v-html="renderMarkdownBlocksAsHtml(message.text)" />
                  <div v-if="showImplementPlanButton(message)" class="plan-card-actions">
                    <button
                      type="button"
                      class="plan-card-implement-button"
                      @click="implementPlan(message)"
                    >
                      Implement plan
                    </button>
                  </div>
                </div>
                <ConversationRichText
                  v-else
                  :message="message"
                  :message-key="renderKey(message)"
                  :cwd="cwd"
                  :rendering="richTextRendering"
                  :highlight-cache-version="highlightCacheVersion"
                  :markdown-image-failure-version="markdownImageFailureVersion"
                  :copied-code-block-key="copiedCodeBlockKey.startsWith(`${renderKey(message)}:`) ? copiedCodeBlockKey : ''"
                  :copy-failure-key="copyFailureKey.startsWith(`code:${renderKey(message)}:`) ? copyFailureKey : ''"
                  @copy-code="copyCodeBlock"
                  @preview-image="openImageModal"
                />
                <button
                  v-if="isTurnErrorMessage(message) && message.turnId"
                  type="button"
                  class="quota-error-ignore"
                  :aria-pressed="ignoredQuotaTurns.includes(message.turnId)"
                  :title="t(ignoredQuotaTurns.includes(message.turnId) ? '取消忽略' : '忽略')"
                  :disabled="quotaIgnorePending"
                  @click="toggleQuotaError(message.turnId)"
                >{{ t(ignoredQuotaTurns.includes(message.turnId) ? '已忽略' : '忽略') }}</button>
                <span v-if="isTurnErrorMessage(message) && quotaIgnoreError" role="alert">{{ t(quotaIgnoreError) }}</span>
                <a
                  v-if="isTurnErrorMessage(message)"
                  class="turn-error-feedback"
                  :href="feedbackMailto"
                  @click="prepareTurnErrorFeedback($event, message.text)"
                >
                  Send feedback
                </a>
              </article>

              <ConversationFileChangeSummary
                v-if="readAnchoredFileChangeSummary(message)"
                :summary="readAnchoredFileChangeSummary(message)!"
                :message-key="renderKey(message)"
                :cwd="cwd"
                inline
                :expanded="isFileChangeSummaryExpanded(renderKey(message))"
                :actionable="isFileChangeActionable(readAnchoredFileChangeSummary(message))"
                :pending="isFileChangeActionPending()"
                :next-action="fileChangeNextAction(readAnchoredFileChangeSummary(message))"
                :action-label="fileChangeActionLabel(readAnchoredFileChangeSummary(message))"
                :action-error="fileChangeActionErrorText(readAnchoredFileChangeSummary(message))"
                @toggle="toggleFileChangeSummary(renderKey(message))"
                @show-diff="openDiffViewer(readAnchoredFileChangeSummary(message), $event)"
                @action="onFileChangeActionClick($event, readAnchoredFileChangeSummary(message))"
              />

              <p v-if="message.deliveryState" class="conversation-delivery-status" :data-status="message.deliveryState.status" :title="message.deliveryState.error" role="status">
                {{ t(conversationDeliveryLabel(message.deliveryState.status)) }}
              </p>
              <div
                v-if="showCopyResponseButton(message) || showEditMessageButton(message)"
                class="message-toolbar"
                :data-role="message.role"
              >
                <button
                  v-if="showEditMessageButton(message)"
                  type="button"
                  class="message-edit-button"
                  aria-label="Edit this message"
                  title="Edit this message"
                  @click="editMessage(renderKey(message))"
                >
                  <IconTablerFilePencil class="icon-svg message-edit-icon" />
                  <span class="message-edit-label">Edit message</span>
                </button>
                <button
                  v-if="showForkResponseButton(message)"
                  type="button"
                  class="message-fork-button"
                  aria-label="Fork thread from this response"
                  title="Fork thread from this response"
                  @click="forkResponse(renderKey(message))"
                >
                  <IconTablerGitFork class="icon-svg message-fork-icon" />
                  <span class="message-fork-label">Fork</span>
                </button>
                <button
                  v-if="showCopyResponseButton(message)"
                  type="button"
                  class="message-copy-button"
                  :data-copied="copiedResponseAnchorId === renderKey(message)"
                  :aria-label="copiedResponseAnchorId === renderKey(message) ? 'Response copied' : 'Copy response'"
                  :title="copiedResponseAnchorId === renderKey(message) ? 'Response copied' : 'Copy response'"
                  @click="copyResponse(renderKey(message))"
                >
                  <IconTablerCopy class="icon-svg message-copy-icon" />
                  <span class="message-copy-label">{{ copyFailureKey === `response:${renderKey(message)}` ? t('Copy failed') : copiedResponseAnchorId === renderKey(message) ? t('Copied') : t('Copy') }}</span>
                </button>
              </div>
            </article>
          </div>
        </div>
      </li>
      </template>
      <li v-if="liveOverlay" class="conversation-item conversation-item-overlay">
        <div class="message-row">
          <div class="message-stack">
            <article class="live-overlay-inline" aria-live="polite">
              <p class="live-overlay-label">{{ t(liveOverlay.activityLabel) }}</p>
              <p
                v-if="liveOverlay.reasoningText"
                class="live-overlay-reasoning"
              >
                {{ liveOverlay.reasoningText }}
              </p>
              <div v-if="liveOverlay.errorText" class="live-overlay-error">
                <span>{{ t(liveOverlay.errorText) }}</span>
                <a class="live-overlay-feedback" :href="feedbackMailto" @click="prepareLiveErrorFeedback($event, liveOverlay.errorText)">Send feedback</a>
              </div>
            </article>
          </div>
        </div>
      </li>
      <li ref="bottomAnchorRef" class="conversation-bottom-anchor" />
    </ul>

    <button
      v-if="showJumpToLatestButton"
      type="button"
      class="jump-to-latest-button"
      title="Jump to latest"
      aria-label="Jump to latest output"
      @click="jumpToLatest"
    >
      <IconTablerArrowUp class="icon-svg jump-to-latest-icon" />
    </button>

    <div v-if="modalImageUrl.length > 0" class="image-modal-backdrop" @click="closeImageModal">
      <div class="image-modal-content" @click.stop>
        <button class="image-modal-close" type="button" aria-label="Close image preview" @click="closeImageModal">
          <IconTablerX class="icon-svg" />
        </button>
        <img class="image-modal-image" :src="modalImageUrl" alt="Expanded message image" />
      </div>
    </div>

    <div
      v-if="isFileLinkContextMenuVisible"
      ref="fileLinkContextMenuRef"
      class="file-link-context-menu"
      :style="fileLinkContextMenuStyle"
      @click.stop
    >
      <button type="button" class="file-link-context-menu-item" @click="openFileLinkContextBrowse">
        Open link
      </button>
      <button type="button" class="file-link-context-menu-item" @click="copyFileLinkContextLink">
        Copy link
      </button>
      <button
        v-if="fileLinkContextEditUrl"
        type="button"
        class="file-link-context-menu-item"
        @click="openFileLinkContextEdit"
      >
        Edit file
      </button>
    </div>

    <ConversationDiffViewer
      v-if="activeDiffViewerChange"
      :diff-viewer-changes="diffViewerChanges"
      :active-diff-viewer-change="activeDiffViewerChange"
      :is-diff-viewer-file-list-open="isDiffViewerFileListOpen"
      :cwd="cwd"
      @close="closeDiffViewer"
      @toggle-file-list="toggleDiffViewerFileList"
      @close-file-list="closeDiffViewerFileList"
      @select="selectDiffViewerChange"
    />
  </section>
</template>

<script setup lang="ts">
import ConversationFileChangeSummary from './ConversationFileChangeSummary.vue'
import ConversationDiffViewer from './ConversationDiffViewer.vue'
import ConversationCommandResults from './ConversationCommandResults.vue'
import ConversationWorkedResults from './ConversationWorkedResults.vue'
import ConversationRichText from './ConversationRichText.vue'
import { useConversationFilePresentation } from '../../composables/useConversationFilePresentation'
import { useConversationMessagePresentation } from '../../composables/useConversationMessagePresentation'
import { isCommandMessage, isFileChangeMessage, isPlanMessage, isTurnErrorMessage, readPlanExplanation, readPlanSteps, planStepStatusIcon, getCommandsForWorked } from '../../composables/conversationMessagePresentation'
import { useConversationRendering } from '../../composables/useConversationRendering'
import { conversationDeliveryLabel } from '../../conversationDelivery'
import { messageRenderKey } from '../../messageIdentity'
import SubtaskEventCard from './SubtaskEventCard.vue'
import { formatLocalDateTime } from '../../dateTime'
import { useIgnoredQuotaErrors } from '../../composables/useIgnoredQuotaErrors'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useConversationViewport } from '../../composables/useConversationViewport'
import { useConversationFileChangeProjection, type TurnFileChangeSummary } from '../../composables/conversationFileChangeProjection'
import type { UiLiveOverlay, UiMessage, UiServerRequest } from '../../types/codex'
import { createConversationFileActionsController } from '../../composables/conversationFileActionsController'
import { useFeedbackDiagnostics } from '../../composables/useFeedbackDiagnostics'
import { useUiLanguage } from '../../composables/useUiLanguage'
import IconTablerArrowUp from '../icons/IconTablerArrowUp.vue'
import IconTablerCopy from '../icons/IconTablerCopy.vue'
import IconTablerFilePencil from '../icons/IconTablerFilePencil.vue'
import IconTablerGitFork from '../icons/IconTablerGitFork.vue'
import IconTablerX from '../icons/IconTablerX.vue'

const { openFeedbackReport, feedbackUrl, recordVisibleFailure } = useFeedbackDiagnostics()

const feedbackMailto = feedbackUrl

function prepareLiveErrorFeedback(event: MouseEvent, message: string): void {
  recordVisibleFailure(message)
  openFeedbackReport(event)
}

function prepareTurnErrorFeedback(event: MouseEvent, message: string): void {
  recordVisibleFailure(message)
  openFeedbackReport(event)
}

const props = defineProps<{
  messages: UiMessage[]
  pendingRequests: UiServerRequest[]
  liveOverlay: UiLiveOverlay | null
  isLoading: boolean
  activeThreadId: string
  cwd: string
  accountRevision?: number
  hasMorePersistedAbove?: boolean
  isLoadingPersistedAbove?: boolean
  loadEarlierMessages?: (threadId: string) => Promise<void>
}>()

const { ignored: ignoredQuotaTurns, pending: quotaIgnorePending, error: quotaIgnoreError, toggle: toggleQuotaError } = useIgnoredQuotaErrors(computed(() => props.messages.some(message => isTurnErrorMessage(message) && message.turnId) ? props.activeThreadId : ''))

const emit = defineEmits<{
  openTask: [threadId: string]
  forkThread: [payload: { threadId: string; turnId: string }]
  rollback: [payload: { turnId: string }]
  implementPlan: [payload: { turnId: string }]
}>()

const conversationListRef = ref<HTMLElement | null>(null)

const bottomAnchorRef = ref<HTMLElement | null>(null)

const { t } = useUiLanguage()

const filePresentation = useConversationFilePresentation({
  getThreadId: () => props.activeThreadId,
  getCwd: () => props.cwd,
  getAccountRevision: () => props.accountRevision ?? 0,
})

const {
  diffViewerChanges, activeDiffViewerChange, isDiffViewerFileListOpen,
  toggleFileChangeSummary, isFileChangeSummaryExpanded, pruneFileChangeSummaries,
  openDiffViewer, closeDiffViewer, toggleDiffViewerFileList, closeDiffViewerFileList, selectDiffViewerChange,
} = filePresentation

const fileChangeActions = createConversationFileActionsController({
  getThreadId: () => props.activeThreadId,
  getCwd: () => props.cwd,
  getAccountRevision: () => props.accountRevision ?? 0,
})

const {
  isFileChangeActionable, isFileChangeActionPending,
  fileChangeActionErrorText, fileChangeNextAction, fileChangeActionLabel,
  runFileChangeAction,
} = fileChangeActions

const {
  anchoredFileChangeSummaryByAnchorId,
  standaloneFileChangeSummaryByMessageId,
  hiddenFileChangeMessageIds,
} = useConversationFileChangeProjection(
  computed(() => props.messages),
  (message) => messageRenderKey(message, props.activeThreadId || ''),
)

const viewport = useConversationViewport({
  container: conversationListRef,
  bottomAnchor: bottomAnchorRef,
  getThreadId: () => props.activeThreadId,
  getCwd: () => props.cwd,
  getAccountRevision: () => props.accountRevision ?? 0,
  getMessages: () => props.messages,
  getPendingRequests: () => props.pendingRequests,
  getLiveOverlay: () => props.liveOverlay,
  isLoading: () => props.isLoading,
  hasMorePersistedAbove: () => props.hasMorePersistedAbove === true,
  isLoadingPersistedAbove: () => props.isLoadingPersistedAbove === true,
  loadEarlierMessages: (threadId) => props.loadEarlierMessages?.(threadId),
})

const {
  visibleMessages,
  hasMoreAbove,
  isLoadingMore,
  historyLoadError,
  showJumpToLatestButton,
  loadMoreAbove,
  onConversationScroll,
  jumpToLatest,
} = viewport

const rendering = useConversationRendering({
  getThreadId: () => props.activeThreadId,
  getCwd: () => props.cwd,
  getAccountRevision: () => props.accountRevision ?? 0,
  getMessages: () => props.messages,
})

const { toBrowseUrl, renderMarkdownBlocksAsHtml, highlightCacheVersion, markdownImageFailureVersion } = rendering
const richTextRendering = {
  getMessageBlocks: rendering.getMessageBlocks,
  getInlineSegments: rendering.getInlineSegments,
  toBrowseUrl: rendering.toBrowseUrl,
  renderListItemContentAsHtml: rendering.renderListItemContentAsHtml,
  renderCachedHighlightedCodeAsHtml: rendering.renderCachedHighlightedCodeAsHtml,
  isMarkdownImageFailed: rendering.isMarkdownImageFailed,
  onMarkdownImageError: rendering.onMarkdownImageError,
}

function readAnchoredFileChangeSummary(message: UiMessage): TurnFileChangeSummary | null {
  return anchoredFileChangeSummaryByAnchorId.value[renderKey(message)] ?? null
}

function readStandaloneFileChangeSummary(message: UiMessage): TurnFileChangeSummary | null {
  return standaloneFileChangeSummaryByMessageId.value[renderKey(message)] ?? null
}

async function onFileChangeActionClick(event: MouseEvent, summary: TurnFileChangeSummary | null): Promise<void> {
  const button = event.currentTarget as HTMLButtonElement | null
  const wasFocused = !!button && document.activeElement === button
  const threadId = props.activeThreadId
  const cwd = props.cwd
  const accountRevision = props.accountRevision ?? 0
  await runFileChangeAction(summary, fileChangeNextAction(summary))
  await nextTick()
  if (
    wasFocused && button?.isConnected && !button.disabled && document.activeElement === document.body
    && props.activeThreadId === threadId && props.cwd === cwd && (props.accountRevision ?? 0) === accountRevision
  ) {
    button.focus({ preventScroll: true })
  }
}

const messagePresentation = useConversationMessagePresentation({
  getThreadId: () => props.activeThreadId,
  getCwd: () => props.cwd,
  getAccountRevision: () => props.accountRevision ?? 0,
  getMessages: () => props.messages,
  getLiveOverlay: () => props.liveOverlay,
  isLoading: () => props.isLoading,
  getAnchoredFileChanges: () => anchoredFileChangeSummaryByAnchorId.value,
  forkThread: (payload) => emit('forkThread', payload),
  rollback: (payload) => emit('rollback', payload),
  implementPlan: (payload) => emit('implementPlan', payload),
})
const {
  showImplementPlanButton, implementPlan, hiddenGroupedCommandIds, showCopyResponseButton,
  showForkResponseButton, copyResponse, copyCodeBlock, forkResponse,
  showEditMessageButton, editMessage, openImageModal, closeImageModal,
  onConversationContextMenu, openFileLinkContextBrowse, openFileLinkContextEdit, copyFileLinkContextLink,
  modalImageUrl, copiedResponseAnchorId, copiedCodeBlockKey, copyFailureKey,
  isFileLinkContextMenuVisible, fileLinkContextEditUrl, fileLinkContextMenuRef, fileLinkContextMenuStyle,
  commandResults,
} = messagePresentation
const { isWorkedExpanded } = commandResults
function renderKey(message: UiMessage): string { return messageRenderKey(message, props.activeThreadId || '') }

watch([() => props.messages, () => props.isLoading], ([, isLoading]) => {
  if (isLoading) return
  pruneFileChangeSummaries(new Set([
    ...Object.keys(anchoredFileChangeSummaryByAnchorId.value),
    ...Object.keys(standaloneFileChangeSummaryByMessageId.value),
  ]))
})

onBeforeUnmount(() => fileChangeActions.stop())

defineExpose({
  jumpToLatest,
})
</script>

<style scoped>
@reference "tailwindcss";

.conversation-root {
  @apply relative h-full min-h-0 min-w-0 p-0 flex flex-col overflow-y-hidden overflow-x-hidden bg-transparent border-none rounded-none;
}

.conversation-loading {
  @apply m-0 px-6 text-sm text-slate-500;
}

.conversation-empty {
  @apply m-0 px-6 text-sm text-slate-500;
}

.conversation-list {
  @apply h-full min-h-0 list-none m-0 px-2 sm:px-6 py-0 overflow-y-auto overflow-x-visible flex flex-col gap-2 sm:gap-3;
}

.conversation-load-more {
  @apply flex justify-center py-3 m-0;
}

.load-more-button {
  @apply px-4 py-1.5 text-xs rounded-full border border-slate-300 dark:border-slate-600
         text-slate-500 dark:text-slate-400 bg-transparent
         hover:bg-slate-100 dark:hover:bg-slate-800
         disabled:opacity-40 disabled:cursor-not-allowed
         transition-colors cursor-pointer;
}

.conversation-item {
  @apply m-0 w-full min-w-0 flex;
}

.conversation-item-request {
  @apply justify-center;
}

.conversation-item-overlay {
  @apply justify-center;
}

.message-row {
  @apply relative w-full min-w-0 max-w-[min(var(--chat-column-max,45rem),100%)] mx-auto flex;
}

.message-row[data-role='user'] {
  @apply justify-end;
}

.message-row[data-role='assistant'],
.message-row[data-role='system'] {
  @apply justify-start;
}

.conversation-bottom-anchor {
  @apply h-px;
}

.jump-to-latest-button {
  @apply absolute left-1/2 bottom-4 z-20 inline-flex h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full border border-slate-300 bg-white/96 text-slate-700 shadow-lg shadow-slate-900/10 transition hover:-translate-x-1/2 hover:-translate-y-0.5 hover:bg-white hover:text-slate-900;
}

.jump-to-latest-icon {
  transform: rotate(180deg);
}


.live-overlay-inline {
  @apply w-full max-w-[min(var(--chat-column-max,45rem),100%)] px-0 py-1 flex flex-col gap-1;
}

.live-overlay-label {
  @apply m-0 text-sm leading-5 font-medium text-zinc-600;
}

.live-overlay-reasoning {
  @apply m-0 text-sm leading-5 text-zinc-500 whitespace-pre-wrap break-words;
  display: block;
  max-height: calc(1.25rem * 5);
  overflow: auto;
  overflow-wrap: anywhere;
  scrollbar-width: none;
  mask-image: linear-gradient(to top, black 75%, transparent 100%);
  -webkit-mask-image: linear-gradient(to top, black 75%, transparent 100%);
}

.live-overlay-reasoning::-webkit-scrollbar {
  display: none;
}

.live-overlay-error {
  @apply m-0 flex items-start justify-between gap-3 text-sm leading-5 text-rose-600 whitespace-pre-wrap;
}

.live-overlay-feedback {
  @apply shrink-0 rounded-full border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold leading-none text-rose-700 transition hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-300;
}

.turn-error-feedback {
  @apply mt-3 inline-flex w-fit rounded-full border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold leading-none text-rose-700 transition hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-300;
}

.message-body {
  @apply flex flex-col min-w-0 max-w-full;
  width: fit-content;
}

.message-body[data-role='user'] {
  @apply ml-auto items-end;
  align-self: flex-end;
}

.message-toolbar {
  @apply mt-1 self-start flex items-center gap-1 opacity-[0.01] transition-opacity duration-200;
}

.message-row:hover .message-toolbar {
  @apply opacity-100;
}

.message-copy-button {
  @apply inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-white/90 px-1.25 py-0.5 text-[9px] font-medium leading-none text-slate-500 transition hover:border-slate-300 hover:bg-white hover:text-slate-900;
}

.message-fork-button {
  @apply inline-flex items-center gap-0.5 px-0.5 py-0 text-[9px] font-medium leading-none text-slate-500 transition hover:text-slate-900;
}


.message-copy-button[data-copied='true'] {
  @apply border-emerald-200 bg-emerald-50 text-emerald-700;
}

.message-edit-button {
  @apply inline-flex items-center gap-0.5 px-0.5 py-0 text-[9px] font-medium leading-none text-amber-600/70 transition hover:text-amber-700;
}

.message-fork-icon,
.message-copy-icon,
.message-edit-icon {
  @apply text-[10px];
}

.message-fork-label,
.message-copy-label,
.message-edit-label {
  @apply leading-none;
}

.message-image-list {
  @apply list-none m-0 mb-2 p-0 flex flex-wrap gap-2;
}

.message-image-list[data-role='user'] {
  @apply ml-auto justify-end;
}

.message-generated-image-list {
  @apply gap-3;
}

.message-image-item {
  @apply m-0;
}



.message-image-button {
  @apply block rounded-xl overflow-hidden border border-slate-300 bg-white p-0 transition hover:border-slate-400;
}
.message-image-preview {
  @apply block w-16 h-16 object-cover;
}

.message-generated-image-preview {
  @apply w-auto h-auto max-w-[min(560px,85vw)] max-h-[min(460px,62vh)] object-contain bg-white;
}

.message-file-attachments {
  @apply mb-2 flex flex-wrap gap-1.5;
}

.message-skill-attachments {
  @apply mb-2 flex flex-wrap justify-end gap-1.5;
}

.message-file-chip {
  @apply inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-700;
}

.message-skill-chip {
  @apply inline-flex max-w-full items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 no-underline transition hover:border-emerald-300 hover:bg-emerald-100 hover:text-emerald-900;
}

.message-skill-chip-prefix {
  @apply shrink-0 font-medium text-emerald-700;
}

.message-skill-chip-name {
  @apply min-w-0 max-w-48 truncate font-mono;
}

.message-file-chip-icon {
  @apply text-[10px] leading-none;
}

.message-file-chip-name {
  @apply truncate max-w-48 font-mono;
}

.message-card {
  @apply max-w-[min(var(--chat-card-max,76ch),100%)] px-0 py-0 bg-transparent border-none rounded-none;
}

.message-text-flow {
  @apply flex flex-col gap-2;
}

.plan-card {
  @apply flex max-w-[min(var(--chat-card-max,76ch),100%)] flex-col gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-slate-900;
}

.plan-card-header {
  @apply flex items-center justify-between gap-3;
}

.plan-card-title {
  @apply m-0 text-sm font-semibold leading-5 text-sky-900;
}

.plan-card-badge {
  @apply inline-flex items-center rounded-full bg-sky-200 px-2 py-0.5 text-[11px] font-medium leading-4 text-sky-900;
}

.plan-card-explanation {
  @apply text-slate-700;
}

.plan-card-markdown {
  @apply flex flex-col gap-2;
}

.plan-card-markdown :deep(.message-text),
.plan-card-markdown :deep(.message-heading),
.plan-card-markdown :deep(.message-blockquote),
.plan-card-markdown :deep(.message-list),
.plan-card-markdown :deep(.message-table-wrap),
.plan-card-markdown :deep(.message-code-block),
.plan-card-markdown :deep(.message-divider) {
  @apply m-0;
}

.plan-card-markdown :deep(.message-text) {
  @apply text-sm leading-relaxed whitespace-pre-wrap text-slate-800;
}

.plan-card-markdown :deep(.message-heading) {
  @apply text-slate-900 tracking-tight;
}

.plan-card-markdown :deep(.message-heading-h1) {
  @apply text-2xl font-semibold leading-tight;
}

.plan-card-markdown :deep(.message-heading-h2) {
  @apply text-xl font-semibold leading-tight;
}

.plan-card-markdown :deep(.message-heading-h3) {
  @apply text-lg font-semibold leading-snug;
}

.plan-card-markdown :deep(.message-heading-h4) {
  @apply text-base font-semibold leading-snug;
}

.plan-card-markdown :deep(.message-heading-h5) {
  @apply text-sm font-semibold leading-snug uppercase tracking-[0.02em];
}

.plan-card-markdown :deep(.message-heading-h6) {
  @apply text-xs font-semibold leading-snug uppercase tracking-[0.04em] text-slate-600;
}

.plan-card-markdown :deep(.message-blockquote) {
  @apply border-l-4 border-slate-300 pl-4 py-1 text-sm leading-relaxed whitespace-pre-wrap text-slate-700 bg-slate-50/70 rounded-r-lg;
}

.plan-card-markdown :deep(.message-list) {
  @apply pl-5 text-sm leading-relaxed text-slate-800 flex flex-col gap-1.5;
}

.plan-card-markdown :deep(.message-list-unordered) {
  @apply list-disc;
}

.plan-card-markdown :deep(.message-list-ordered) {
  @apply list-decimal;
}

.plan-card-markdown :deep(.message-list-item) {
  @apply pl-1;
}

.plan-card-markdown :deep(.message-list-item-text) {
  @apply whitespace-pre-wrap;
}

.plan-card-markdown :deep(.message-list-item-paragraph + .message-list-item-paragraph) {
  @apply mt-2;
}

.plan-card-markdown :deep(.message-task-list) {
  @apply list-none pl-0;
}

.plan-card-markdown :deep(.message-task-item) {
  @apply flex items-start gap-2;
}

.plan-card-markdown :deep(.message-task-checkbox) {
  @apply mt-0.5 text-sm leading-none text-slate-500 select-none;
}

.plan-card-markdown :deep(.message-code-block) {
  @apply overflow-hidden rounded-xl border border-slate-200 bg-slate-950/95 text-slate-100;
}

.plan-card-markdown :deep(.message-code-language) {
  @apply border-b border-slate-800 bg-slate-900/90 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.08em] text-slate-400;
}

.plan-card-markdown :deep(.message-code-pre) {
  @apply m-0 overflow-x-auto px-3 py-3 text-[13px] leading-6;
}

.plan-card-markdown :deep(.message-inline-code) {
  @apply bg-transparent p-0 font-sans text-[1em] font-semibold text-inherit;
}

.plan-card-markdown :deep(.message-file-link) {
  @apply text-sky-700 underline decoration-sky-300 underline-offset-2;
}

.plan-card-markdown :deep(.message-table) {
  @apply bg-white/90;
}

.plan-step-list {
  @apply m-0 flex list-none flex-col gap-2 p-0;
}

.plan-step-item {
  @apply flex items-start gap-2 rounded-xl border border-white/70 bg-white/80 px-3 py-2 text-sm leading-relaxed text-slate-800;
}

.plan-step-item[data-status='completed'] {
  @apply border-emerald-200 bg-emerald-50/80;
}

.plan-step-item[data-status='inProgress'] {
  @apply border-amber-200 bg-amber-50/80;
}

.plan-step-status {
  @apply mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700;
}

.plan-step-status[data-status='completed'] {
  @apply bg-emerald-200 text-emerald-900;
}

.plan-step-status[data-status='inProgress'] {
  @apply bg-amber-200 text-amber-900;
}

.plan-step-text {
  @apply min-w-0 flex-1;
}

.plan-card-actions {
  @apply mt-3 flex justify-end;
}

.plan-card-implement-button {
  @apply inline-flex items-center rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 transition hover:border-slate-400 hover:bg-slate-50;
}

.message-file-link {
  @apply text-sm leading-relaxed text-[#0969da] no-underline hover:text-[#1f6feb] hover:underline underline-offset-2;
}

.file-link-context-menu {
  @apply fixed z-50 min-w-36 rounded-lg border border-zinc-200 bg-white p-1 shadow-xl;
}

.file-link-context-menu-item {
  @apply block w-full rounded-md px-2 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100;
}




.message-card[data-role='user'] {
  @apply rounded-2xl bg-slate-200 px-4 py-3 max-w-[min(560px,100%)];
  width: fit-content;
  margin-left: auto;
  align-self: flex-end;
}

.automation-message-label {
  @apply mb-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500;
}

.automation-message-label code {
  @apply rounded-full bg-white/70 px-2 py-0.5 text-[10px] normal-case tracking-normal text-slate-600;
}

.message-card[data-role='assistant'],
.message-card[data-role='system'] {
  @apply px-0 py-0 bg-transparent border-none rounded-none;
}

:global(.dark) .message-file-chip {
  @apply border-zinc-700 bg-zinc-900 text-zinc-200;
}

:global(.dark) .message-skill-chip {
  @apply border-emerald-800/70 bg-emerald-950/50 text-emerald-100;
}

:global(.dark) .message-skill-chip-prefix {
  @apply text-emerald-300;
}

.conversation-item[data-message-type='worked'] .message-stack,
.conversation-item[data-message-type='worked'] .message-body,
.conversation-item[data-message-type='worked'] .message-card {
  @apply w-full max-w-full;
}

.image-modal-backdrop {
  @apply fixed inset-0 z-50 bg-black/40 p-6 flex items-center justify-center;
}

.image-modal-content {
  @apply relative max-w-[min(92vw,1100px)] max-h-[92vh];
}

.image-modal-close {
  @apply absolute top-2 right-2 z-10 w-10 h-10 rounded-full bg-white/90 text-slate-900 border border-slate-300 flex items-center justify-center;
}

.image-modal-image {
  @apply block max-w-full max-h-[90vh] rounded-2xl shadow-2xl bg-white;
}

.icon-svg {
  @apply w-5 h-5;
}

</style>
<style src="./conversationToolGroup.css"></style>
<style src="./conversationFileBadges.css"></style>
