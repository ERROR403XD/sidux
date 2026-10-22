import { flattenThreads, isVirtualProjectId } from '../projectOrganization'
import { isProjectlessChatPath } from '../pathUtils'
import { notifyOperation } from './useOperationToast'
import { createBrowserTaskNotifications } from './browserTaskNotifications'
import { useConversationDeliveries } from './useConversationDeliveries'
import { restoreCompactionRequests } from '../api/threadCompaction'
import { ref } from 'vue'
import { createThreadConversationController } from './threadConversationController'
import { createThreadUsageController } from './threadUsageController'
import { createThreadTerminalController } from './threadTerminalController'
import { createDesktopRefreshController } from './desktopRefreshController'
import { createThreadListController } from './threadListController'
import { createThreadHistoryController } from './threadHistoryController'
import { createThreadSynchronizationController } from './threadSynchronizationController'
import { createThreadRealtimeController } from './threadRealtimeController'
import { createThreadPendingRequestController } from './threadPendingRequestController'
import { extractThreadIdFromNotification } from './threadNotificationValues'
import { createThreadQueueController } from './threadQueueController'
import { createThreadSendController } from './threadSendController'
import { createThreadMetadataController } from './threadMetadataController'
import { createThreadMutationController } from './threadMutationController'
import { createThreadModelController } from './threadModelController'
import { createThreadCompletionController } from './threadCompletionController'
import { createThreadSelectionController } from './threadSelectionController'
import { createThreadStatusController } from './threadStatusController'
import { createThreadSubscriptionController } from './threadSubscriptionController'
import { NEW_THREAD_COLLABORATION_MODE_CONTEXT } from './threadContextState'
import type {
  UiMessage,
  UiThread,
} from '../types/codex'
import { createProjectOrganizationController } from './projectOrganizationController'

const EVENT_SYNC_DEBOUNCE_MS = 220
const BACKGROUND_THREAD_PAGINATION_DELAY_MS = 10_000
const RECENT_THREAD_MESSAGE_LOAD_REUSE_MS = 2000
const RECENT_THREAD_LIST_LOAD_REUSE_MS = 2000
const MODEL_FALLBACK_ID = 'gpt-5.4-mini'

export function useDesktopState(options: { isThreadVisible?: (threadId: string) => boolean } = {}) {
  const conversationDeliveries = useConversationDeliveries()
  const desktopRefreshController = createDesktopRefreshController({
    getSelectedThreadId: () => selectedThreadId.value,
    getErrorThreadIds: () => threadStatusController.getErrorThreadIds(),
    setPageError: message => { error.value = message },
    setCliMissingError: message => { codexCliMissingError.value = message },
    metadata: {
      invalidateForAccountChange: () => threadMetadataController.invalidateForAccountChange(),
      invalidateQuotaCache: () => threadMetadataController.invalidateQuotaCache(),
      refresh: options => refreshAncillaryState(options),
      scheduleRefresh: options => scheduleAncillaryStateRefresh(options),
    },
    send: { invalidateForAccountChange: () => threadSendController.invalidateForAccountChange() },
    pending: { invalidateForAccountChange: () => threadPendingRequestController.invalidateForAccountChange() },
    synchronization: { invalidateForAccountChange: () => threadSynchronizationController.invalidateForAccountChange() },
    queue: {
      invalidateForAccountChange: () => threadQueueController.invalidateForAccountChange(),
      loadPersistedStateIfNeeded: () => threadQueueController.loadPersistedStateIfNeeded(),
    },
    completion: { resetAcknowledgements: () => resetCompletionAcknowledgements() },
    mutation: { invalidateForAccountChange: () => threadMutationController.invalidateForAccountChange() },
    model: {
      invalidateForAccountChange: () => threadModelController.invalidateForAccountChange(),
      invalidateCatalog: () => threadModelController.invalidateCatalog(),
    },
    list: {
      resetForAccountChange: () => threadListController.resetForAccountChange(),
      load: options => loadThreads(options),
    },
    history: {
      invalidateForAccountChange: threadIds => threadHistoryController.invalidateForAccountChange(threadIds),
      load: threadId => loadMessages(threadId),
    },
  })
  const { refreshAll } = desktopRefreshController
  const projectOrganizationController = createProjectOrganizationController({
    selection: {
      getThreadId: () => selectedThreadId.value,
      setThreadId: threadId => setSelectedThreadId(threadId),
    },
    titles: { applyCachedToGroups: groups => applyCachedTitlesToGroups(groups) },
    status: {
      isInProgress: threadId => threadStatusController.isInProgress(threadId),
      getInProgressMap: () => threadStatusController.getInProgressMap(),
      markServerListedThreads: threadIds => markServerListedThreads(threadIds),
      pruneInProgress: threadIds => threadStatusController.pruneInProgress(threadIds),
      removeThread: threadId => threadStatusController.removeThread(threadId),
    },
    getPendingRequestState: threadId => threadPendingRequestController.getRequestState(threadId),
    getUnreadToken: threadId => threadCompletionController.getUnreadToken(threadId),
    isBackgroundCompleted: threadId => threadCompletionController.isBackgroundCompleted(threadId),
    list: {
      removeThread: threadId => threadListController.removeThread(threadId),
      load: options => loadThreads(options),
    },
    pruneThreadState: pruneThreadScopedState,
  })
  const {
    projectGroups, projectDisplayNameById, applyThreadFlags, insertOptimisticThread, currentThreadVersion,
    hydrateWorkspaceRootsStateIfNeeded, applyThreadGroups, removeArchivedThreadFromLoadedLists,
    renameProject, removeProject, reorderProject, pinProjectToTop,
  } = projectOrganizationController
  const threadSelectionController = createThreadSelectionController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    getListedThreads: () => flattenThreads(projectGroups.value),
    getSnapshot: threadId => threadHistoryController.getSnapshot(threadId),
    getVirtualProjects: () => threadListController.rootsState?.virtualProjects,
    history: { load: (threadId, options) => loadMessages(threadId, options) },
    model: {
      projectSelectedThread: threadId => threadModelController.projectSelectedThread(threadId),
      refreshModelPreferences: options => refreshModelPreferences(options),
    },
    metadata: {
      getTitle: threadId => threadMetadataController.getTitle(threadId),
      refreshSkills: () => refreshSkills(),
    },
    errors: {
      setPage: message => { error.value = message },
      setTurn: (threadId, message, options) => setTurnErrorForThread(threadId, message, options),
    },
    resetReasoningItem: () => threadRealtimeController.resetReasoningItem(),
    onChanged: applyThreadFlags,
  })
  const {
    selectedThreadId, selectedThread, setSelectedThreadId, primeSelectedThread, selectThread,
    selectedCollaborationMode, setSelectedCollaborationMode, setSelectedCollaborationModeForThread,
  } = threadSelectionController

  const threadStatusController = createThreadStatusController({
    getSelectedThreadId: () => selectedThreadId.value,
    getPersistedMessages: threadId => persistedMessagesByThreadId.value[threadId] ?? [],
    list: {
      hasNextPage: () => threadListController.hasNextPage,
      scheduleRemainingPages: () => threadListController.scheduleRemainingPages(),
    },
    live: {
      getReasoningText: threadId => threadLiveReasoningState.getText(threadId),
      clearPlans: threadId => threadLivePlanState.clear(threadId),
      clearReasoning: threadId => threadLiveReasoningState.clear(threadId),
      clearCommands: threadId => threadLiveCommandState.clear(threadId),
      resetReasoningItem: () => threadRealtimeController.resetReasoningItem(),
    },
    onChanged: applyThreadFlags,
  })
  const {
    selectedLiveOverlay, isSelectedThreadInterruptPending, applyListedStatuses,
    setTurnSummaryForThread, setTurnActivityForThread, setTurnErrorForThread,
    setThreadInProgress,
    clearTransientTurnErrorForThread, clearAllTransientTurnErrors, clearCompletedTurnLiveState,
    blockInterruptUntilThreadIsPersisted, maybeUnblockInterruptForActiveTurn,
    markServerListedThreads, markThreadMessagesPersisted,
    inferNextTurnIndex, setTurnIndexForThread, replaceTurnIndexLookupForThread,
  } = threadStatusController
  const codexCliMissingError = ref('')
  const threadModelController = createThreadModelController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    getSelectedThreadId: () => selectedThreadId.value,
    setPageError: message => { error.value = message },
    setCliMissingError: message => { codexCliMissingError.value = message },
  })
  const {
    webPreferenceState, webPreferenceError, webDefaultChoice, webDefaultsProvider,
    configureWebDefaults, initializeWebConversation,
    availableModelIds, availableModels, modelCatalogError, reportedModel, selectedModelId,
    selectedReasoningEffort, selectedSpeedMode, isUpdatingSpeedMode,
    setSelectedReasoningEffort, updateSelectedSpeedMode,
    refreshModelPreferences, readModelIdForThread, readProviderIdForThread,
    setSelectedModelIdForThread, setSelectedModelId, setThreadModelId, setThreadModelProviderId,
    resolveThreadModelForProvider, checkedModelSettings, saveCurrentModelSettings, ensureAvailableModelIds,
  } = threadModelController

  const threadHistoryController = createThreadHistoryController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    getSelectedThreadId: () => selectedThreadId.value,
    getThreadVersion: currentThreadVersion,
    reuseMs: RECENT_THREAD_MESSAGE_LOAD_REUSE_MS,
    metadata: {
      setProvider: setThreadModelProviderId,
      setModel: (threadId, model, provider) => setThreadModelId(threadId, resolveThreadModelForProvider(threadId, model, provider)),
    },
    status: {
      isInProgress: threadId => threadStatusController.isInProgress(threadId),
      setInProgress: setThreadInProgress,
      hasTransientError: threadId => threadStatusController.hasTransientError(threadId),
      setTransientError: (threadId, message) => setTurnErrorForThread(threadId, message, { transient: true }),
      clearTransientError: clearTransientTurnErrorForThread,
      setPageError: message => {
        error.value = message
      },
    },
    turns: {
      getLookup: threadId => threadStatusController.turnOrder.getLookup(threadId),
      replaceLookup: replaceTurnIndexLookupForThread,
      markMessagesPersisted: markThreadMessagesPersisted,
      rebindLiveFileChanges: rebindLiveFileChangeTurnIndices,
      getActiveTurnId: threadId => threadStatusController.activeTurn.getTurnId(threadId),
      setActiveTurnId: (threadId, turnId) => threadStatusController.activeTurn.setTurnId(threadId, turnId),
      clearActiveTurn: threadId => threadStatusController.activeTurn.clear(threadId),
    },
    live: {
      getAgentMessages: threadId => threadLiveAgentState.getMessages(threadId),
      setAgentMessages: setLiveAgentMessagesForThread,
      clearAgentMessages: clearLiveAgentMessagesForThread,
      removePersistedCommands: removeLiveCommandsPersistedIn,
      removePersistedFileChanges: removeLiveFileChangesPersistedIn,
      clearCompleted: clearCompletedTurnLiveState,
    },
    deliveries: {
      refresh: conversationDeliveries.refresh,
      refreshReceipts: threadId => refreshVisibleDeliveryReceipts(threadId),
      observe: conversationDeliveries.observe,
    },
    scheduleEventSync: () => threadSynchronizationController.schedule(),
  })
  const {
    persistedMessagesByThreadId,
    loadingMessagesByThreadId,
    hasMoreOlderMessagesByThreadId,
    loadingOlderMessagesByThreadId,
    loadMessages,
    loadOlderMessages,
    ensureThreadMessagesLoaded,
    setPersistedMessagesForThread,
  } = threadHistoryController

  const threadQueueController = createThreadQueueController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    getSelectedThreadId: () => selectedThreadId.value,
    getPersistedMessages: threadId => persistedMessagesByThreadId.value[threadId] ?? [],
    getActiveTurnId: threadId => threadStatusController.activeTurn.getTurnId(threadId),
    readNextUserMessageOrdinal: (threadId, turnId) => threadConversationController.readNextUserMessageOrdinal(threadId, turnId),
    getDeliveryRows: () => conversationDeliveries.rows.value,
    conversationDeliveries: {
      syncQueue: conversationDeliveries.syncQueue,
      begin: conversationDeliveries.begin,
      patch: conversationDeliveries.patch,
      observe: conversationDeliveries.observe,
    },
    appendOptimisticUserMessage: (...args) => threadConversationController.appendOptimisticUserMessage(...args),
    markThreadHistoryDirty,
    scheduleDelayedTurnSync: threadId => threadMetadataController.scheduleDelayedTurnSync(threadId),
    setPageError: message => { error.value = message },
    notifyQueueError: (message, threadId) => notifyOperation(message, 'error', threadId),
    scheduleTimeout: (callback, delay) => window.setTimeout(callback, delay),
    cancelTimeout: timer => window.clearTimeout(timer),
  })
  const {
    selectedThreadQueueError, selectedThreadQueuedMessages, queueStateError,
    commitQueueOperation, refreshQueueState, refreshVisibleDeliveryReceipts, removeQueuedMessage,
    reorderQueuedMessage, changeQueuedMessage, beginQueuedMessageEdit, updateQueuedMessage, steerQueuedMessage,
    scheduleQueueStateRefresh,
  } = threadQueueController
  const threadCompletionController = createThreadCompletionController({
    getSelectedThreadId: () => selectedThreadId.value,
    isThreadVisible: options.isThreadVisible,
    onChanged: applyThreadFlags,
  })
  const { loadCompletionList, markThreadAsRead, markProjectAsRead, resetCompletionAcknowledgements } = threadCompletionController

  const threadPendingRequestController = createThreadPendingRequestController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    onChanged: applyThreadFlags,
    setPageError: message => { error.value = message },
  })
  const {
    load: loadPendingServerRequestsFromBridge,
    respond: respondToPendingServerRequest,
  } = threadPendingRequestController

  const threadUsageController = createThreadUsageController({ getSelectedThreadId: () => selectedThreadId.value })
  const { selectedThreadTokenUsage, setThreadTokenUsage } = threadUsageController
  const threadTerminalController = createThreadTerminalController({ getSelectedThreadId: () => selectedThreadId.value })
  const { selectedThreadTerminalOpen, setThreadTerminalOpen, toggleSelectedThreadTerminal } = threadTerminalController

  const error = ref('')

  const threadMetadataController = createThreadMetadataController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    getSelectedCwd: () => selectedThread.value?.cwd ?? '',
    getCollaborationMode: () => selectedCollaborationMode.value,
    setCollaborationMode: setSelectedCollaborationMode,
    refreshModels: refreshModelPreferences,
    onTitlesChanged: applyThreadFlags,
    markHistoryDirty: markThreadHistoryDirty,
    syncFromNotifications: () => syncFromNotifications(),
  })
  const {
    availableCollaborationModes, installedSkills, accountRateLimitSnapshots,
    quota: codexQuota, refreshSkills, refreshRateLimits,
    applyCachedTitlesToGroups, loadThreadTitleCacheIfNeeded, requestThreadTitleGeneration,
    refreshAncillaryState, scheduleAncillaryStateRefresh, scheduleRateLimitRefresh,
    scheduleDelayedTurnSync, clearDelayedTurnSync,
  } = threadMetadataController
  const threadSynchronizationController = createThreadSynchronizationController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    getSelectedThreadId: () => selectedThreadId.value,
    isInProgress: threadId => threadStatusController.isInProgress(threadId),
    list: {
      hasLoaded: () => hasLoadedThreads.value,
      getVersion: currentThreadVersion,
      load: options => loadThreads(options),
    },
    history: {
      getPendingThreadIds: () => threadHistoryController.history.pendingThreadIds,
      takePendingThreadIds: threadHistoryController.history.takePendingThreadIds,
      markDirty: threadHistoryController.history.markDirty,
      isLoaded: threadHistoryController.isLoaded,
      getLoadedVersion: threadHistoryController.getLoadedVersion,
      load: loadMessages,
    },
    loadPendingServerRequests: loadPendingServerRequestsFromBridge,
    extractThreadId: extractThreadIdFromNotification,
    delayMs: EVENT_SYNC_DEBOUNCE_MS,
    scheduleTimeout: (callback, delay) => window.setTimeout(callback, delay),
    cancelTimeout: timer => window.clearTimeout(timer),
  })
  const { syncFromNotifications } = threadSynchronizationController
  const threadRealtimeController = createThreadRealtimeController({
    getSelectedThreadId: () => selectedThreadId.value,
    history: {
      getMessages: threadId => persistedMessagesByThreadId.value[threadId] ?? [],
      setMessages: setPersistedMessagesForThread,
    },
    turns: {
      getIndex: threadStatusController.turnOrder.getTurnIndex,
      setIndex: setTurnIndexForThread,
      inferNextIndex: inferNextTurnIndex,
      getActiveTurnId: threadStatusController.activeTurn.getTurnId,
      setActiveTurnId: threadStatusController.activeTurn.setTurnId,
      clearActiveTurn: threadStatusController.activeTurn.clear,
      unblockInterrupt: maybeUnblockInterruptForActiveTurn,
    },
    status: {
      setInProgress: setThreadInProgress,
      setActivity: setTurnActivityForThread,
      setSummary: setTurnSummaryForThread,
      setError: setTurnErrorForThread,
      clearTransientError: clearTransientTurnErrorForThread,
      setPageError: message => { error.value = message },
    },
    metadata: {
      markSearchChanged: () => threadConversationController.markSearchChanged(),
      refreshModels: refreshModelPreferences,
      setAuthRecovery: threadPendingRequestController.setAuthRecovery,
      setReportedModel: threadModelController.setReportedModel,
      setTitle: (threadId, title) => {
        threadMetadataController.setTitle(threadId, title)
        applyThreadFlags()
      },
      markQuotaUpdated: threadMetadataController.markQuotaUpdated,
      scheduleQuotaRefresh: scheduleRateLimitRefresh,
      getQuotaSnapshot: () => codexQuota.value,
      applyQuotaSnapshot: threadMetadataController.observeQuota,
      setTokenUsage: setThreadTokenUsage,
    },
    handleServerRequest: threadPendingRequestController.handleNotification,
    scheduleQueueRefresh: scheduleQueueStateRefresh,
    clearDelayedTurnSync,
  })
  const {
    plans: threadLivePlanState,
    agents: threadLiveAgentState,
    reasoning: threadLiveReasoningState,
    commands: threadLiveCommandState,
    fileChanges: threadLiveFileChangeState,
  } = threadRealtimeController
  const threadSubscriptionController = createThreadSubscriptionController({
    notifyBrowser: createBrowserTaskNotifications(threadId => {
      const thread = flattenThreads(projectGroups.value).find(thread => thread.id === threadId)
      if (!thread) return undefined
      const projectName = !thread.cwd || (isProjectlessChatPath(thread.cwd) && !isVirtualProjectId(thread.projectName))
        ? '' : (projectDisplayNameById.value[thread.projectName] ?? thread.projectName).trim()
      return { title: thread.title, projectName }
    }),
    pending: { load: loadPendingServerRequestsFromBridge },
    completion: { load: loadCompletionList, handleChange: threadCompletionController.handleCompletionChange },
    queue: { refresh: refreshQueueState },
    model: { resetCatalog: threadModelController.resetCatalog, refresh: refreshModelPreferences },
    quota: { invalidateCache: threadMetadataController.invalidateQuotaCache, refresh: refreshRateLimits },
    status: { clearTransientErrors: clearAllTransientTurnErrors },
    realtime: { handle: threadRealtimeController.handle },
    synchronization: { recover: threadSynchronizationController.recoverBridgeState, queue: threadSynchronizationController.queue },
  })
  function markThreadHistoryDirty(threadId: string) {
    threadHistoryController.history.markDirty(threadId)
  }

  const threadSendController = createThreadSendController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    isModelSettingsUpdating: () => isUpdatingSpeedMode.value,
    newThreadModelContext: NEW_THREAD_COLLABORATION_MODE_CONTEXT,
    modelFallbackId: MODEL_FALLBACK_ID,
    selection: {
      getThreadId: () => selectedThreadId.value,
      getCollaborationMode: () => selectedCollaborationMode.value,
      getReasoningEffort: () => selectedReasoningEffort.value,
      getSpeedMode: () => selectedSpeedMode.value,
      setThreadId: setSelectedThreadId,
      setModelProjection: threadModelController.setModelProjection,
      setCollaborationMode: setSelectedCollaborationModeForThread,
    },
    model: {
      readId: readModelIdForThread,
      readProviderId: readProviderIdForThread,
      getActiveProviderId: threadModelController.getActiveProviderId,
      getSettings: checkedModelSettings,
      setId: setThreadModelId,
      setProviderId: setThreadModelProviderId,
      resolveForProvider: resolveThreadModelForProvider,
      getCatalog: threadModelController.getCatalog,
      setCatalog: threadModelController.replaceCatalog,
      ensureAvailableIds: ensureAvailableModelIds,
    },
    preferences: {
      getNewThreadChoice: threadModelController.getNewThreadChoice,
      register: threadModelController.registerWebConversation,
      saveModelSettings: saveCurrentModelSettings,
    },
    history: {
      getMessages: threadId => persistedMessagesByThreadId.value[threadId] ?? [],
      getLiveMessages: threadLiveAgentState.getMessages,
      setMessages: setPersistedMessagesForThread,
      isResumed: threadHistoryController.isResumed,
      markResumed: threadHistoryController.markResumed,
      markDirty: markThreadHistoryDirty,
    },
    turn: {
      isInProgress: threadId => threadStatusController.isInProgress(threadId),
      setInProgress: setThreadInProgress,
      getActiveId: threadStatusController.activeTurn.getTurnId,
      setActiveId: threadStatusController.activeTurn.setTurnId,
      setSummary: setTurnSummaryForThread,
      setActivity: setTurnActivityForThread,
      setError: setTurnErrorForThread,
      blockInterrupt: blockInterruptUntilThreadIsPersisted,
      unblockInterrupt: maybeUnblockInterruptForActiveTurn,
    },
    queue: { getMessages: threadQueueController.getMessages, commit: commitQueueOperation, refresh: refreshQueueState },
    conversationDeliveries: {
      begin: conversationDeliveries.begin, patch: conversationDeliveries.patch,
      replaceId: conversationDeliveries.replaceId, refresh: conversationDeliveries.refresh,
      observe: conversationDeliveries.observe,
    },
    getDeliveryRows: () => conversationDeliveries.rows.value,
    readNextUserMessageOrdinal: (threadId, turnId) => threadConversationController.readNextUserMessageOrdinal(threadId, turnId),
    appendOptimisticUserMessage: (...args) => threadConversationController.appendOptimisticUserMessage(...args),
    insertOptimisticThread,
    requestThreadTitleGeneration,
    setPageError: message => { error.value = message },
    syncFromNotifications, scheduleDelayedTurnSync,
  })
  const { isSendingMessage, captureThreadSendContext, sendMessageToSelectedThread, sendMessageToNewThread, answerAsyncQuestions } = threadSendController

  const threadListController = createThreadListController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    getStatusRevisions: () => threadStatusController.captureRevisions(),
    applyListedStatuses,
    loadTitleCache: loadThreadTitleCacheIfNeeded,
    hydrateWorkspace: hydrateWorkspaceRootsStateIfNeeded,
    view: {
      commitGroups: applyThreadGroups,
      getVisibleThreads: () => flattenThreads(projectGroups.value),
      pruneThreadState: pruneThreadScopedState,
      getSelectedThreadId: () => selectedThreadId.value,
      setSelectedThreadId,
    },
    reuseMs: RECENT_THREAD_LIST_LOAD_REUSE_MS,
    paginationDelayMs: BACKGROUND_THREAD_PAGINATION_DELAY_MS,
    scheduleTimeout: (callback, delay) => window.setTimeout(callback, delay),
    cancelTimeout: timer => window.clearTimeout(timer),
  })
  const { isLoadingThreads, isThreadListFullyLoaded, hasLoadedThreads, loadThreads } = threadListController

  const threadMutationController = createThreadMutationController({
    getAccountRevision: () => desktopRefreshController.getAccountRevision(),
    selection: {
      getThreadId: () => selectedThreadId.value,
      getCwd: () => selectedThread.value?.cwd ?? '',
      setThreadId: setSelectedThreadId,
    },
    list: {
      getVisibleThreads: () => flattenThreads(projectGroups.value),
      getSourceThreads: projectOrganizationController.getSourceThreads,
      removeArchivedThread: removeArchivedThreadFromLoadedLists,
      load: () => loadThreads(),
    },
    history: {
      getMessages: threadId => persistedMessagesByThreadId.value[threadId] ?? [],
      markResumed: threadHistoryController.markResumed,
      ensureLoaded: ensureThreadMessagesLoaded,
      load: loadMessages,
      invalidateForRollback: threadHistoryController.invalidateForRollback,
      setMessages: setPersistedMessagesForThread,
      markDirty: markThreadHistoryDirty,
    },
    status: {
      isInProgress: threadId => threadStatusController.isInProgress(threadId),
      isInterruptBlocked: threadId => threadStatusController.isInterruptBlocked(threadId),
      setInProgress: setThreadInProgress,
    },
    activeTurn: {
      getTurnId: threadStatusController.activeTurn.getTurnId,
      setTurnId: threadStatusController.activeTurn.setTurnId,
      clear: threadStatusController.activeTurn.clear,
    },
    turnOrder: {
      maxTurnIndex: threadStatusController.turnOrder.maxTurnIndex,
      replaceLookup: replaceTurnIndexLookupForThread,
    },
    live: {
      setAgentMessages: setLiveAgentMessagesForThread,
      clearReasoning: threadLiveReasoningState.clear,
      clearCommands: threadLiveCommandState.clear,
    },
    turns: {
      clearSummary: threadId => setTurnSummaryForThread(threadId, null),
      clearActivity: threadId => setTurnActivityForThread(threadId, null),
      clearError: threadId => setTurnErrorForThread(threadId, null),
      setError: (threadId, message) => setTurnErrorForThread(threadId, message),
    },
    synchronization: { markThreadsDirty: threadSynchronizationController.markThreadsDirty, sync: syncFromNotifications },
    model: { readId: readModelIdForThread, setId: setThreadModelId },
    titles: { set: threadMetadataController.setTitle, persist: threadMetadataController.persistTitle },
    onTitlesChanged: applyThreadFlags,
    markSearchChanged: () => threadConversationController.markSearchChanged(),
    insertOptimisticThread,
    setPageError: message => { error.value = message },
  })
  const {
    archiveThreadById, renameThreadById, forkThreadById, forkThreadFromTurn,
    rollbackSelectedThread, isRollingBack, captureThreadActionContext,
    interruptSelectedThreadTurn, isInterruptingTurn,
  } = threadMutationController

  const threadConversationController = createThreadConversationController({
    getSelectedThreadId: () => selectedThreadId.value,
    history: {
      getMessages: threadId => persistedMessagesByThreadId.value[threadId] ?? [],
      setMessages: setPersistedMessagesForThread,
      isLoading: threadId => loadingMessagesByThreadId.value[threadId] === true,
      hasMoreOlder: threadId => hasMoreOlderMessagesByThreadId.value[threadId] === true,
      isLoadingOlder: threadId => loadingOlderMessagesByThreadId.value[threadId] === true,
    },
    live: {
      getPlans: threadLivePlanState.getMessages,
      getAgents: threadLiveAgentState.getMessages,
      getCommands: threadLiveCommandState.getMessages,
      getFileChanges: threadLiveFileChangeState.getMessages,
    },
    getSummary: threadStatusController.getSummary,
    deliveries: { project: conversationDeliveries.project, getRows: () => conversationDeliveries.rows.value },
    pending: { getRequests: threadPendingRequestController.getRequests, getAuthRecovery: threadPendingRequestController.getAuthRecovery },
  })
  const {
    selectedAuthRecovery, isLoadingMessages, selectedThreadServerRequests, messages,
    hasMoreOlderMessages, isLoadingOlderMessages, threadSearchVersion,
  } = threadConversationController

  function pruneThreadScopedState(flatThreads: UiThread[]): void {
    const activeThreadIds = new Set(flatThreads.map((thread) => thread.id))
    const currentThreadId = selectedThreadId.value.trim()
    if (currentThreadId) {
      activeThreadIds.add(currentThreadId)
    }
    threadHistoryController.pruneSnapshots(activeThreadIds)
    threadModelController.prunePreferences(activeThreadIds)
    threadSelectionController.pruneCollaborationPreferences(activeThreadIds)
    // The current list may be paginated or filtered. Absence is not deletion;
    // retaining read markers prevents older pages becoming unread after reload.
    threadHistoryController.prune(activeThreadIds)
    threadStatusController.pruneTurnOrder(activeThreadIds)
    threadRealtimeController.pruneLiveState(activeThreadIds)
    threadStatusController.pruneTurnState(activeThreadIds)
    threadModelController.pruneThreadMetadata(activeThreadIds)
    threadUsageController.prune(activeThreadIds)
    threadStatusController.pruneInProgress(activeThreadIds)
    threadPendingRequestController.prune(activeThreadIds)
  }

  function setLiveAgentMessagesForThread(threadId: string, nextMessages: readonly UiMessage[]): void {
    threadLiveAgentState.set(threadId, nextMessages)
  }

  function clearLiveAgentMessagesForThread(threadId: string): void {
    threadLiveAgentState.clear(threadId)
  }

  function rebindLiveFileChangeTurnIndices(threadId: string): void {
    threadLiveFileChangeState.rebindTurnIndices(threadId, threadStatusController.turnOrder.getLookup(threadId))
  }

  function removeLiveCommandsPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    threadLiveCommandState.removePersistedIn(threadId, persistedMessages)
  }

  function removeLiveFileChangesPersistedIn(threadId: string, persistedMessages: UiMessage[]): void {
    threadLiveFileChangeState.removePersistedIn(threadId, persistedMessages)
  }

  function clearRegisteredTimeouts(): void {
    threadQueueController.stop()
    projectOrganizationController.stop()
  }

  function startPolling(): void {
    if (typeof window === 'undefined') return
    threadSelectionController.start()
    threadMutationController.start()
    threadMetadataController.start()
    threadModelController.start()
    threadCompletionController.start()
    threadSendController.start()
    threadPendingRequestController.start()
    threadRealtimeController.start()
    threadSynchronizationController.start()
    threadListController.start()
    threadQueueController.start()
    restoreCompactionRequests()

    if (threadSubscriptionController.isStarted()) return
    conversationDeliveries.start()
    threadSubscriptionController.start()
  }

  function stopPolling(): void {
    threadSelectionController.stop()
    desktopRefreshController.invalidateReads()
    threadSubscriptionController.invalidate()
    threadMutationController.stop()
    threadMetadataController.stop()
    threadSendController.stop()
    threadListController.stop()
    threadHistoryController.stop()
    threadCompletionController.stop()
    if (typeof window !== 'undefined') conversationDeliveries.stop()
    threadPendingRequestController.stop()
    threadModelController.stop()
    threadMetadataController.invalidateQuotaCache()
    threadSubscriptionController.close()

    threadSynchronizationController.stop()
    threadRealtimeController.stop()
    clearRegisteredTimeouts()
    threadRealtimeController.resetReasoningItem()
    threadHistoryController.resetSnapshots()
    threadStatusController.resetProgress()
    threadRealtimeController.resetLiveState()
    threadStatusController.resetTurnState()
    threadUsageController.reset()
  }

  return {
    markProjectAsRead,
    readConversationChoice: threadModelController.readConversationChoice,
    webPreferenceState, webPreferenceError, webDefaultChoice, configureWebDefaults, initializeWebConversation,
    webDefaultsProvider,
    projectGroups,
    projectDisplayNameById,
    selectedThread,
    selectedThreadTokenUsage,
    selectedThreadTerminalOpen,
    isSelectedThreadInterruptPending,
    selectedThreadServerRequests,
    selectedLiveOverlay,
    codexQuota,
    selectedThreadId,
    availableCollaborationModes,
    availableModelIds,
    availableModels,
    modelCatalogError,
    reportedModel,
    selectedCollaborationMode,
    selectedModelId,
    selectedReasoningEffort,
    selectedSpeedMode,
    codexCliMissingError,
    installedSkills,
    accountRateLimitSnapshots,
    messages,
    hasMoreOlderMessages,
    threadSearchVersion,
    isLoadingThreads,
    isThreadListFullyLoaded,
    isLoadingMessages,
    isLoadingOlderMessages,
    isSendingMessage,
    isInterruptingTurn,
    isUpdatingSpeedMode,
    isRollingBack,

    error,
    captureThreadActionContext,
    refreshAll,
    refreshSkills,
    selectThread,
    markThreadAsRead,
    loadMessages,
    loadOlderMessages,
    ensureThreadMessagesLoaded,
    setThreadTerminalOpen,
    toggleSelectedThreadTerminal,
    archiveThreadById,
    renameThreadById,
    forkThreadById,
    forkThreadFromTurn,
    rollbackSelectedThread,

    sendMessageToSelectedThread,
    sendMessageToNewThread,
    captureThreadSendContext,
    interruptSelectedThreadTurn,
    selectedThreadQueuedMessages,
    selectedThreadQueueError,
    queueStateError,
    removeQueuedMessage,
    beginQueuedMessageEdit,
    updateQueuedMessage,
    changeQueuedMessage,
    refreshQueueState,
    reorderQueuedMessage,
    steerQueuedMessage,
    setSelectedCollaborationMode,
    readModelIdForThread,
    setSelectedModelIdForThread,
    setSelectedModelId,

    setSelectedReasoningEffort,
    updateSelectedSpeedMode,
    selectedAuthRecovery,
    respondToPendingServerRequest,
    pendingReplyIds: threadPendingRequestController.replyIds,
    pendingReplyErrors: threadPendingRequestController.replyErrors,
    capturePendingReplyContext: threadPendingRequestController.captureContext,
    answerAsyncQuestions,
    renameProject,
    removeProject,
    reorderProject,
    pinProjectToTop,
    startPolling,
    stopPolling,
    primeSelectedThread,
  }
}
