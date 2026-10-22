import { computed, onScopeDispose, readonly, ref, watch } from 'vue'
import type { UiLiveOverlay, UiMessage } from '../types/codex'
import { messageRenderKey } from '../messageIdentity'
import { copyTextToClipboard } from '../utils/clipboard'
import { useConversationCommandProjection } from './conversationCommandProjection'
import { buildFileChangeCopyText } from './conversationFilePresentation'
import type { TurnFileChangeSummary } from './conversationFileChangeProjection'
import { isCommandMessage, isPlanMessage, isCopyableAssistantMessage, commandStatusClass, pruneCommandIdSet, buildCopyableMessageContent } from './conversationMessagePresentation'

type MessagePresentationOptions = {
  getThreadId: () => string
  getCwd: () => string
  getAccountRevision: () => number
  getMessages: () => UiMessage[]
  getLiveOverlay: () => UiLiveOverlay | null
  isLoading: () => boolean
  getAnchoredFileChanges: () => Record<string, TurnFileChangeSummary>
  forkThread: (payload: { threadId: string; turnId: string }) => void
  rollback: (payload: { turnId: string }) => void
  implementPlan: (payload: { turnId: string }) => void
  writeClipboard?: (text: string) => Promise<void>
}

export function useConversationMessagePresentation(options: MessagePresentationOptions) {
  const writeClipboard = options.writeClipboard ?? copyTextToClipboard
  const expandedCommandIds = ref<Set<string>>(new Set())
  const collapsedAutoCommandIds = ref<Set<string>>(new Set())
  const expandedCommandGroupIds = ref<Set<string>>(new Set())
  const expandedWorkedIds = ref<Set<string>>(new Set())
  const fileLinkContextMenuRef = ref<HTMLElement | null>(null)
  const isFileLinkContextMenuVisible = ref(false)
  const fileLinkContextMenuX = ref(0)
  const fileLinkContextMenuY = ref(0)
  const fileLinkContextBrowseUrl = ref('')
  const fileLinkContextEditUrl = ref('')

  function showImplementPlanButton(message: UiMessage): boolean {
    return isPlanMessage(message)
      && message.messageType !== 'plan.live'
      && message.role === 'assistant'
      && Boolean(message.turnId)
  }

  function implementPlan(message: UiMessage): void {
    if (messagePresentationStopped) return
    const turnId = message.turnId?.trim() ?? ''
    if (!turnId) return
    options.implementPlan({ turnId })
  }

  const hasLiveAssistantText = computed(() =>
    options.getMessages().some((message) =>
      message.role === 'assistant' &&
      message.messageType === 'agentMessage.live' &&
      message.text.trim().length > 0,
    ),
  )

  const isLiveTurnRuntime = computed(() =>
    Boolean(options.getLiveOverlay()) || activeCommandMessageId.value.length > 0 || hasLiveAssistantText.value,
  )

  function isCommandAutoExpanded(message: UiMessage): boolean {
    if (messagePresentationStopped) return false
    return !hasLiveAssistantText.value && renderKey(message) === activeCommandMessageId.value
  }

  function isCommandExpanded(message: UiMessage): boolean {
    if (!isCommandMessage(message)) return false
    return expandedCommandIds.value.has(renderKey(message))
      || (!collapsedAutoCommandIds.value.has(renderKey(message)) && isCommandAutoExpanded(message))
  }

  function isCommandCompact(message: UiMessage): boolean {
    return isCommandMessage(message) && isLiveTurnRuntime.value
  }

  function isCommandOutputCondensed(message: UiMessage): boolean {
    return isCommandMessage(message) && (isLiveTurnRuntime.value || message.commandExecution?.status === 'inProgress')
  }

  function toggleCommandExpand(message: UiMessage): void {
    if (messagePresentationStopped) return
    if (!isCommandMessage(message)) return

    const nextExpanded = new Set(expandedCommandIds.value)
    const nextCollapsedAuto = new Set(collapsedAutoCommandIds.value)
    const isAutoExpanded = isCommandAutoExpanded(message)
    const isManuallyExpanded = nextExpanded.has(renderKey(message))

    if (isManuallyExpanded) {
      nextExpanded.delete(renderKey(message))
      if (isAutoExpanded) nextCollapsedAuto.add(renderKey(message))
    } else if (isAutoExpanded && !nextCollapsedAuto.has(renderKey(message))) {
      nextCollapsedAuto.add(renderKey(message))
    } else {
      nextExpanded.add(renderKey(message))
      nextCollapsedAuto.delete(renderKey(message))
    }

    expandedCommandIds.value = nextExpanded
    collapsedAutoCommandIds.value = nextCollapsedAuto
  }

  function getGroupedCommandsForLatest(message: UiMessage): UiMessage[] {
    return groupedCommandsByLatestId.value[renderKey(message)] ?? []
  }

  function getCommandBlockForLatest(message: UiMessage): UiMessage[] {
    if (!isCommandMessage(message)) return []
    return [...getGroupedCommandsForLatest(message), message]
  }

  function toggleCommandGroup(message: UiMessage): void {
    if (messagePresentationStopped) return
    const groupedCommands = getGroupedCommandsForLatest(message)
    if (groupedCommands.length === 0) return
    const next = new Set(expandedCommandGroupIds.value)
    if (next.has(renderKey(message))) next.delete(renderKey(message))
    else next.add(renderKey(message))
    expandedCommandGroupIds.value = next
  }

  function isCommandGroupExpanded(message: UiMessage): boolean {
    return expandedCommandGroupIds.value.has(renderKey(message))
  }

  function commandGroupSummaryLabel(message: UiMessage): string {
    const commands = getCommandBlockForLatest(message)
    const count = commands.length
    const latestCommand = message.commandExecution?.command?.trim() || '(command)'
    const countLabel = count === 1 ? '1 command' : `${count} commands`
    return `${countLabel} · latest: ${latestCommand}`
  }

  function commandGroupSummaryStatus(message: UiMessage): string {
    return commandStatusLabel(message)
  }

  function toggleWorkedExpand(message: UiMessage): void {
    if (messagePresentationStopped) return
    const next = new Set(expandedWorkedIds.value)
    if (next.has(renderKey(message))) next.delete(renderKey(message))
    else next.add(renderKey(message))
    expandedWorkedIds.value = next
  }

  function isWorkedExpanded(message: UiMessage): boolean {
    return expandedWorkedIds.value.has(renderKey(message))
  }

  function commandStatusLabel(message: UiMessage): string {
    const ce = message.commandExecution
    if (!ce) return ''
    const compact = isCommandCompact(message)
    switch (ce.status) {
      case 'inProgress': return compact ? 'Running' : '⟳ Running'
      case 'completed': return ce.exitCode === 0 ? (compact ? 'Done' : '✓ Completed') : `Exit ${ce.exitCode ?? '?'}`
      case 'failed': return compact ? 'Failed' : '✗ Failed'
      case 'declined': return compact ? 'Declined' : '⊘ Declined'
      case 'interrupted': return compact ? 'Stopped' : '⊘ Interrupted'
      default: return ''
    }
  }

  const modalImageUrl = ref('')
  const copiedResponseAnchorId = ref('')
  const copiedCodeBlockKey = ref('')
  const copyFailureKey = ref('')

  let copyAttempt = 0

  let messagePresentationStopped = false

  let copiedMessageResetTimer: ReturnType<typeof setTimeout> | null = null

  const {
    activeCommandMessageId,
    groupedCommandsByLatestId,
    hiddenGroupedCommandIds,
  } = useConversationCommandProjection(
    computed(() => options.getMessages()),
    (message) => messageRenderKey(message, options.getThreadId() || ''),
  )

  const copyableResponseContentByAnchorId = computed<Record<string, string>>(() => {
    const groupedResponses = new Map<string, { anchorMessageId: string; parts: string[] }>()

    for (const message of options.getMessages()) {
      if (!isCopyableAssistantMessage(message)) continue

      const content = buildCopyableMessageContent(message)
      if (!content) continue

      const responseKey = typeof message.turnIndex === 'number'
        ? `turn:${message.turnIndex}`
        : `message:${renderKey(message)}`
      const existing = groupedResponses.get(responseKey)
      if (existing) {
        existing.anchorMessageId = renderKey(message)
        existing.parts.push(content)
        continue
      }

      groupedResponses.set(responseKey, {
        anchorMessageId: renderKey(message),
        parts: [content],
      })
    }

    const next: Record<string, string> = {}
    for (const response of groupedResponses.values()) {
      const content = response.parts.join('\n\n').trim()
      if (!content) continue
      next[response.anchorMessageId] = content
    }

    for (const [anchorMessageId, summary] of Object.entries(options.getAnchoredFileChanges())) {
      if (summary.source !== 'metadata') continue
      const fileChangeCopy = buildFileChangeCopyText(summary, options.getCwd())
      if (!fileChangeCopy) continue
      const existing = next[anchorMessageId]?.trim()
      next[anchorMessageId] = existing ? `${existing}\n\n${fileChangeCopy}` : fileChangeCopy
    }
    return next
  })

  const forkableTurnIdByAnchorId = computed<Record<string, string>>(() => {
    const anchors = new Map<string, string>()
    for (const message of options.getMessages()) {
      if (isCopyableAssistantMessage(message) && message.turnId) anchors.set(message.turnId, renderKey(message))
    }
    return Object.fromEntries([...anchors].map(([turnId, anchorId]) => [anchorId, turnId]))
  })

  function showCopyResponseButton(message: UiMessage): boolean {
    return typeof copyableResponseContentByAnchorId.value[renderKey(message)] === 'string'
  }

  function showForkResponseButton(message: UiMessage): boolean {
    return typeof forkableTurnIdByAnchorId.value[renderKey(message)] === 'string'
  }

  async function copyResponse(anchorMessageId: string): Promise<void> {
    const content = copyableResponseContentByAnchorId.value[anchorMessageId] ?? ''
    if (!content) return
    await copyMessageText(content, `response:${anchorMessageId}`)
  }

  async function copyCodeBlock(key: string, content: string): Promise<void> {
    await copyMessageText(content, `code:${key}`)
  }

  async function copyMessageText(content: string, key: string): Promise<void> {
    if (messagePresentationStopped) return
    const attempt = ++copyAttempt
    clearCopyFeedback()
    copyFailureKey.value = ''
    try {
      await writeClipboard(content)
    } catch {
      if (!messagePresentationStopped && attempt === copyAttempt) copyFailureKey.value = key
      return
    }
    if (messagePresentationStopped || attempt !== copyAttempt) return
    copiedResponseAnchorId.value = key.startsWith('response:') ? key.slice('response:'.length) : ''
    copiedCodeBlockKey.value = key.startsWith('code:') ? key.slice('code:'.length) : ''
    copiedMessageResetTimer = setTimeout(() => {
      if (messagePresentationStopped || attempt !== copyAttempt) return
      copiedResponseAnchorId.value = ''
      copiedCodeBlockKey.value = ''
      copiedMessageResetTimer = null
    }, 1800)
  }

  function clearCopyFeedback(): void {
    if (copiedMessageResetTimer) {
      clearTimeout(copiedMessageResetTimer)
      copiedMessageResetTimer = null
    }
    copiedResponseAnchorId.value = ''
    copiedCodeBlockKey.value = ''
    copyFailureKey.value = ''
  }

  function resetMessagePresentation(): void {
    copyAttempt++
    clearCopyFeedback()
    expandedCommandIds.value = new Set()
    collapsedAutoCommandIds.value = new Set()
    expandedCommandGroupIds.value = new Set()
    expandedWorkedIds.value = new Set()
    modalImageUrl.value = ''
    closeFileLinkContextMenu()
  }

  function forkResponse(anchorMessageId: string): void {
    if (messagePresentationStopped) return
    const turnId = forkableTurnIdByAnchorId.value[anchorMessageId]
    if (!turnId) return
    if (!options.getThreadId()) return
    options.forkThread({
      threadId: options.getThreadId(),
      turnId,
    })
  }

  const editableTurnIdByMessageId = computed<Record<string, string>>(() => {
    const next: Record<string, string> = {}
    for (const message of options.getMessages()) {
      if (message.role !== 'user' || typeof message.turnIndex !== 'number') continue
      const turnId = typeof message.turnId === 'string' && message.turnId.length > 0 ? message.turnId : ''
      if (!turnId || message.text.trim().length === 0) continue
      next[renderKey(message)] = turnId
    }
    return next
  })

  function showEditMessageButton(message: UiMessage): boolean {
    return !message.deliveryState && typeof editableTurnIdByMessageId.value[renderKey(message)] === 'string'
  }

  function editMessage(messageId: string): void {
    if (messagePresentationStopped) return
    const turnId = editableTurnIdByMessageId.value[messageId]
    if (!turnId) return
    options.rollback({ turnId })
  }

  const fileLinkContextMenuStyle = computed(() => ({
    left: `${String(fileLinkContextMenuX.value)}px`,
    top: `${String(fileLinkContextMenuY.value)}px`,
  }))

  function toEditUrlFromBrowseHref(href: string): string {
    const normalizedHref = href.trim()
    if (!normalizedHref) return ''
    try {
      const resolved = new URL(normalizedHref, window.location.href)
      if (!resolved.pathname.startsWith('/codex-local-browse')) return ''
      const editPath = `/codex-local-edit${resolved.pathname.slice('/codex-local-browse'.length)}`
      return `${editPath}${resolved.search}${resolved.hash}`
    } catch {
      return ''
    }
  }

  function onConversationContextMenu(event: MouseEvent): void {
    if (messagePresentationStopped) return
    const target = event.target
    if (!(target instanceof Element)) return

    const anchor = target.closest('a.message-file-link')
    if (!(anchor instanceof HTMLAnchorElement)) return

    const href = (anchor.getAttribute('href') ?? '').trim()
    if (!href || href === '#') return

    event.preventDefault()
    event.stopPropagation()

    fileLinkContextBrowseUrl.value = href
    fileLinkContextEditUrl.value = toEditUrlFromBrowseHref(href)
    fileLinkContextMenuX.value = event.clientX
    fileLinkContextMenuY.value = event.clientY
    isFileLinkContextMenuVisible.value = true
  }

  function closeFileLinkContextMenu(): void {
    isFileLinkContextMenuVisible.value = false
    fileLinkContextBrowseUrl.value = ''
    fileLinkContextEditUrl.value = ''
  }

  function openFileLinkContextBrowse(): void {
    if (messagePresentationStopped) return
    const href = fileLinkContextBrowseUrl.value
    closeFileLinkContextMenu()
    if (!href || href === '#') return
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  function openFileLinkContextEdit(): void {
    if (messagePresentationStopped) return
    const href = fileLinkContextEditUrl.value
    closeFileLinkContextMenu()
    if (!href || href === '#') return
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  async function copyFileLinkContextLink(): Promise<void> {
    if (messagePresentationStopped) return
    const href = fileLinkContextBrowseUrl.value
    closeFileLinkContextMenu()
    if (!href || href === '#') return

    try {
      await writeClipboard(href)
    } catch {
      // Clipboard writes can be blocked by browser permissions; keep the context action best-effort.
    }
  }

  function onWindowPointerDownForFileLinkContextMenu(event: PointerEvent): void {
    if (!isFileLinkContextMenuVisible.value) return
    const menu = fileLinkContextMenuRef.value
    if (!menu) {
      closeFileLinkContextMenu()
      return
    }
    const target = event.target
    if (target instanceof Node && menu.contains(target)) return
    closeFileLinkContextMenu()
  }

  function onWindowBlurForFileLinkContextMenu(): void {
    closeFileLinkContextMenu()
  }

  function onWindowKeydownForFileLinkContextMenu(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    closeFileLinkContextMenu()
  }

  function renderKey(message: UiMessage): string { return messageRenderKey(message, options.getThreadId() || '') }

  function openImageModal(imageUrl: string): void {
    if (messagePresentationStopped) return
    modalImageUrl.value = imageUrl
  }

  function closeImageModal(): void {
    modalImageUrl.value = ''
  }

  const stopPruneWatch = watch(
    [() => options.getMessages(), () => options.isLoading()],
    ([next, isLoading]) => {
      if (messagePresentationStopped || isLoading) return

      const commandIds = new Set(
        next
          .filter((message) => message.messageType === 'commandExecution' && message.commandExecution)
          .map((message) => renderKey(message)),
      )
      expandedCommandIds.value = pruneCommandIdSet(expandedCommandIds.value, commandIds)
      collapsedAutoCommandIds.value = pruneCommandIdSet(collapsedAutoCommandIds.value, commandIds)
      expandedCommandGroupIds.value = pruneCommandIdSet(
        expandedCommandGroupIds.value,
        new Set(Object.keys(groupedCommandsByLatestId.value)),
      )
      expandedWorkedIds.value = pruneCommandIdSet(
        expandedWorkedIds.value,
        new Set(next.filter((message) => message.messageType === 'worked').map((message) => renderKey(message))),
      )

    },
  )

  const stopActiveWatch = watch(
    activeCommandMessageId,
    (nextId, prevId) => {
      if (messagePresentationStopped) return
      if (!prevId || prevId === nextId) return
      if (!collapsedAutoCommandIds.value.has(prevId)) return
      const nextCollapsedAuto = new Set(collapsedAutoCommandIds.value)
      nextCollapsedAuto.delete(prevId)
      collapsedAutoCommandIds.value = nextCollapsedAuto
    },
  )

  const stopIdentityWatch = watch(
    [() => options.getThreadId(), () => options.getCwd(), () => options.getAccountRevision() ?? 0],
    resetMessagePresentation,
    { flush: 'sync' },
  )

  const stopMenuWatch = watch(isFileLinkContextMenuVisible, (visible) => {
    if (visible && !messagePresentationStopped) {
      window.addEventListener('pointerdown', onWindowPointerDownForFileLinkContextMenu)
      window.addEventListener('blur', onWindowBlurForFileLinkContextMenu)
      window.addEventListener('keydown', onWindowKeydownForFileLinkContextMenu)
    } else {
      detachMenuListeners()
    }
  }, { flush: 'sync' })

  function detachMenuListeners(): void {
    window.removeEventListener('pointerdown', onWindowPointerDownForFileLinkContextMenu)
    window.removeEventListener('blur', onWindowBlurForFileLinkContextMenu)
    window.removeEventListener('keydown', onWindowKeydownForFileLinkContextMenu)
  }

  function stop(): void {
    if (messagePresentationStopped) return
    messagePresentationStopped = true
    stopPruneWatch()
    stopActiveWatch()
    stopIdentityWatch()
    resetMessagePresentation()
    stopMenuWatch()
    detachMenuListeners()
  }

  onScopeDispose(stop)

  const commandResults = { renderKey, getGroupedCommandsForLatest, getCommandBlockForLatest, toggleCommandGroup, isCommandGroupExpanded, commandGroupSummaryLabel, commandGroupSummaryStatus, isCommandExpanded, isCommandCompact, isCommandOutputCondensed, toggleCommandExpand, commandStatusLabel, commandStatusClass, toggleWorkedExpand, isWorkedExpanded }

  return {
    showImplementPlanButton,
    implementPlan,
    hiddenGroupedCommandIds,
    showCopyResponseButton,
    showForkResponseButton,
    copyResponse,
    copyCodeBlock,
    forkResponse,
    showEditMessageButton,
    editMessage,
    openImageModal,
    closeImageModal,
    onConversationContextMenu,
    openFileLinkContextBrowse,
    openFileLinkContextEdit,
    copyFileLinkContextLink,
    modalImageUrl: readonly(modalImageUrl),
    copiedResponseAnchorId: readonly(copiedResponseAnchorId),
    copiedCodeBlockKey: readonly(copiedCodeBlockKey),
    copyFailureKey: readonly(copyFailureKey),
    isFileLinkContextMenuVisible: readonly(isFileLinkContextMenuVisible),
    fileLinkContextEditUrl: readonly(fileLinkContextEditUrl),
    fileLinkContextBrowseUrl: readonly(fileLinkContextBrowseUrl),
    fileLinkContextMenuRef, fileLinkContextMenuStyle, commandResults, stop,
  }
}

export type ConversationCommandResults = ReturnType<typeof useConversationMessagePresentation>['commandResults']
