import { computed, onScopeDispose, readonly, ref, watch } from 'vue'
import type { UiFileChange } from '../types/codex'
import type { TurnFileChangeSummary } from './conversationFileChangeProjection'
import { fileChangeKey } from './conversationFilePresentation'

type ConversationFilePresentationOptions = {
  getThreadId: () => string
  getCwd: () => string
  getAccountRevision: () => number
}

export function useConversationFilePresentation(options: ConversationFilePresentationOptions) {
  let stopped = false
  const expandedFileChangeSummaryIds = ref<Set<string>>(new Set())
  const activeDiffViewerSummary = ref<TurnFileChangeSummary | null>(null)
  const activeDiffViewerChangeKey = ref('')
  const isDiffViewerFileListOpen = ref(false)

  function toggleFileChangeSummary(messageKey: string): void {
    if (stopped) return
    const next = new Set(expandedFileChangeSummaryIds.value)
    if (next.has(messageKey)) next.delete(messageKey)
    else next.add(messageKey)
    expandedFileChangeSummaryIds.value = next
  }

  function isFileChangeSummaryExpanded(messageKey: string): boolean {
    return expandedFileChangeSummaryIds.value.has(messageKey)
  }

  function openDiffViewer(summary: TurnFileChangeSummary | null, change: UiFileChange): void {
    if (stopped) return
    if (!summary) return
    activeDiffViewerSummary.value = summary
    activeDiffViewerChangeKey.value = fileChangeKey(change)
    isDiffViewerFileListOpen.value = false
  }

  function closeDiffViewer(): void {
    activeDiffViewerSummary.value = null
    activeDiffViewerChangeKey.value = ''
    isDiffViewerFileListOpen.value = false
  }

  function toggleDiffViewerFileList(): void {
    if (stopped) return
    isDiffViewerFileListOpen.value = !isDiffViewerFileListOpen.value
  }

  function closeDiffViewerFileList(): void {
    isDiffViewerFileListOpen.value = false
  }

  function selectDiffViewerChange(change: UiFileChange, isMobile: boolean): void {
    if (stopped) return
    activeDiffViewerChangeKey.value = fileChangeKey(change)
    if (isMobile) {
      isDiffViewerFileListOpen.value = false
    }
  }

  function resetFilePresentation(): void {
    expandedFileChangeSummaryIds.value = new Set()
    closeDiffViewer()
  }

  const diffViewerChanges = computed<UiFileChange[]>(() => activeDiffViewerSummary.value?.changes ?? [])

  const activeDiffViewerChange = computed<UiFileChange | null>(() => {
    const changes = diffViewerChanges.value
    if (changes.length === 0) return null
    return changes.find((change) => fileChangeKey(change) === activeDiffViewerChangeKey.value) ?? changes[0]
  })

  function pruneSummaryIds(source: Set<string>, validIds: Set<string>): Set<string> {
    if (source.size === 0) return source
    const next = new Set<string>()
    for (const id of source) {
      if (validIds.has(id)) next.add(id)
    }
    return next.size === source.size ? source : next
  }

  function pruneFileChangeSummaries(validIds: Set<string>): void {
    if (stopped) return
    expandedFileChangeSummaryIds.value = pruneSummaryIds(expandedFileChangeSummaryIds.value, validIds)
  }

  const stopIdentityWatch = watch(
    [() => options.getThreadId(), () => options.getCwd(), () => options.getAccountRevision()],
    resetFilePresentation,
    { flush: 'sync' },
  )

  function stop(): void {
    if (stopped) return
    stopped = true
    stopIdentityWatch()
    resetFilePresentation()
  }

  onScopeDispose(stop)

  return {
    expandedFileChangeSummaryIds: readonly(expandedFileChangeSummaryIds),
    activeDiffViewerSummary: readonly(activeDiffViewerSummary),
    activeDiffViewerChangeKey: readonly(activeDiffViewerChangeKey),
    isDiffViewerFileListOpen: readonly(isDiffViewerFileListOpen),
    diffViewerChanges: readonly(diffViewerChanges),
    activeDiffViewerChange: readonly(activeDiffViewerChange),
    toggleFileChangeSummary, isFileChangeSummaryExpanded, pruneFileChangeSummaries,
    openDiffViewer, closeDiffViewer, toggleDiffViewerFileList, closeDiffViewerFileList, selectDiffViewerChange, stop,
  }
}
