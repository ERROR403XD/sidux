import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function readSource(name: string) {
  return ts.createSourceFile(name, readFileSync(new URL(name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
}

describe('thread state composition boundaries', () => {
  it('keeps test-only status mutation APIs out of production owners and the desktop surface', () => {
    const violations: string[] = []
    for (const file of ['useDesktopState.ts', 'threadStatusController.ts']) {
      const source = readSource(file)
      function visit(node: ts.Node) {
        if (ts.isIdentifier(node) && /ForTests$/.test(node.text)) violations.push(`${file}:${node.text}`)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })

  it('keeps list loading, pagination and snapshot storage in the list controller', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const privateNames = new Set(['threadListPagination', 'threadListRequestState', 'threadListSnapshotState', 'lastThreadListLoadAt'])
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && privateNames.has(node.name.text)) violations.push(node.name.text)
      if (ts.isFunctionDeclaration(node) && node.name && ['loadThreads', 'loadRemainingThreadPages', 'scheduleRemainingThreadPages'].includes(node.name.text)) violations.push(node.name.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps event refresh policy, recovery and busy ownership out of the parent', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['isPolling', 'threadEventSyncState'].includes(node.name.text)) violations.push(node.name.text)
      if (ts.isFunctionDeclaration(node) && node.name && ['syncFromNotifications', 'recoverBridgeState', 'queueEventDrivenSync', 'syncThreadStatus'].includes(node.name.text)) violations.push(node.name.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps complete history operations and private storage out of the compatibility composable', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const historyOperations = new Set(['loadMessages', 'loadOlderMessages', 'ensureThreadMessagesLoaded', 'setPersistedMessagesForThread'])
    const privateStorage = new Set(['loadedVersionByThreadId', 'historyPositionByThreadId', 'resumedThreadById', 'lastMessageLoadAtByThreadId', 'lastMessageLoadFailureAtByThreadId'])
    const projections = new Set(['persistedMessagesByThreadId', 'loadingMessagesByThreadId', 'hasMoreOlderMessagesByThreadId', 'loadingOlderMessagesByThreadId'])
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && historyOperations.has(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && privateStorage.has(node.name.text)) violations.push(node.name.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let target: ts.Expression = node.left
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
        if (ts.isIdentifier(target) && projections.has(target.text)) violations.push(node.left.getText(source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps notification interpretation and live storage in the realtime owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:applyRealtimeUpdates|read(?:Plan|Turn|Reasoning|AgentMessage|Command|CompletedImage|CompletedFile|ThreadTokenUsage)|normalizeThreadTokenUsage)/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:live(?:PlanMessages|AgentMessages|ReasoningText|Commands|FileChangeMessages)ByThreadId|activeReasoningItemId|threadTurnLifecycleState)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^createThread(?:Live|TurnLifecycle)/.test(node.expression.text)) violations.push(node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps pending snapshots, replies and recovery state in their owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:normalizeServerRequest|normalizePendingServerRequestMethod|loadPendingServerRequestsFromBridge|respondToPendingServerRequest|handleServerRequestNotification|setAuthRecoveryForThread|readPendingRequestState|isApprovalRequestMethod)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:pendingSnapshot|pendingSnapshotRead|authRecoveryByThreadId)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && node.left.getText(source).startsWith('pendingServerRequestsByThreadId.')) violations.push(node.left.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps queue operations, receipt reads and mutable queue storage in their owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:refreshVisibleDeliveryReceipts|commitQueueOperation|captureQueueContext|refreshQueueState|processQueuedMessages|scheduleQueueStateRefresh|scheduleQueueStateRefreshForTests|removeQueuedMessage|reorderQueuedMessage|changeQueuedMessage|beginQueuedMessageEdit|updateQueuedMessage|steerQueuedMessage)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:queuedMessagesByThreadId|queueErrorByThreadId|queueProcessingByThreadId|threadQueueUiState|threadQueueLifecycleState|deliveryReceiptReads)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /(?:threadQueueGateway|threadQueueUiState|threadQueueLifecycleState)$/.test(node.moduleSpecifier.text)) violations.push(node.moduleSpecifier.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps sending policy, question replies and busy state in the send owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:sendMessageToSelectedThread|sendMessageToNewThread|startTurnForThread|answerAsyncQuestions|captureThreadSendContext|resetThreadSendRequest|buildPendingTurnDetails|findLatestUserLocalImageUrl)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:newThreadSendRequest|threadSendStopped)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^(?:startThread|startThreadTurn|resumeThread|getThreadTurnMessages)$/.test(node.expression.text)) violations.push(node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps metadata reads, request slots, caches and timers in their owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const operations = /^(?:captureMetadataContext|resetMetadataReads|setCodexRateLimit|refreshCollaborationModes|refreshRateLimits|scheduleRateLimitRefresh|clearDelayedTurnSync|scheduleDelayedTurnSync|applyCachedTitlesToGroups|loadThreadTitleCacheIfNeeded|requestThreadTitleGeneration|refreshSkills|refreshAncillaryState|scheduleAncillaryStateRefresh)$/
    const storage = /^(?:rateLimitUpdateRevision|recentRateLimitsAt|rateLimitRefreshTimer|ancillaryStateRefreshTimer|delayedTurnSyncTimerByThreadId|metadataStopped|titleCacheReadGeneration|refreshSkillsPromise|hasLoadedSkills|lastSkillsLoadAt|lastSkillsLoadKey|rateLimitRefreshPromise|threadTitleById|codexRateLimit)$/
    const projections = new Set(['availableCollaborationModes', 'installedSkills', 'accountRateLimitSnapshots', 'codexQuota'])
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && operations.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && storage.test(node.name.text)) violations.push(node.name.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let target: ts.Expression = node.left
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
        if (ts.isIdentifier(target) && projections.has(target.text)) violations.push(node.left.getText(source))
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /(?:skillsGateway|executionSettingsGateway|threadPreferencesGateway|accountGateway)$/.test(node.moduleSpecifier.text)) violations.push(node.moduleSpecifier.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps archive, rename and fork policy and action lifecycle in their owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:archiveThreadById|renameThreadById|forkThreadById|forkThreadFromTurn|captureThreadActionContext|toForkedThreadTitle)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'threadActionsStopped') violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^(?:archiveThread|renameThread|forkThread|forkThreadAtTurn)$/.test(node.expression.text)) violations.push(node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps the full rollback operation and private busy slot in the mutation owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:rollbackSelectedThread|resetRollbackRequest)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:isRollingBack|rollbackRequest)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^(?:rollbackThread|revertThreadFileChanges)$/.test(node.expression.text)) violations.push(node.expression.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && node.left.getText(source).startsWith('isRollingBack.')) violations.push(node.left.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps interrupt policy and its private busy slot in the mutation owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:interruptSelectedThreadTurn|resetInterruptRequest)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:isInterruptingTurn|interruptRequest)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^(?:interruptThreadTurn|getThreadDetail)$/.test(node.expression.text)) violations.push(node.expression.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && node.left.getText(source).startsWith('isInterruptingTurn.')) violations.push(node.left.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps complete model policy, preferences, catalog projection and retry ownership out of the parent', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const operations = /^(?:initializeWebConversation|configureWebDefaults|saveCurrentModelSettings|checkedModelSettings|readModelIdForThread|readProviderIdForThread|bindPendingConversationChoiceToActiveProvider|adoptLiveConversationSource|ensureAvailableModelIds|readProviderCompatibleSelectedModel|setSelectedModelIdForThread|setSelectedModelId|setThreadModelId|setThreadModelProviderId|resolveThreadModelForProvider|setSelectedReasoningEffort|updateSelectedSpeedMode|refreshModelPreferences)$/
    const storage = /^(?:webPreferences|savedModelSettings|configuredModelSettings|modelSettingsStorageKey|modelSettingsKey|currentModelSettings|selectedModelCapability|modelRetryTimer|modelRefreshGeneration|selectedModelIdByContext|threadModelProviderByThreadId|reportedModelByThreadId|activeProviderId)$/
    const projections = new Set(['availableModels', 'availableModelIds', 'modelCatalogError', 'selectedModelId', 'webPreferenceState', 'webPreferenceError', 'reportedModel'])
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && operations.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && storage.test(node.name.text)) violations.push(node.name.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let target: ts.Expression = node.left
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
        if (ts.isIdentifier(target) && projections.has(target.text)) violations.push(node.left.getText(source))
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /(?:threadCommandGateway|modelCatalog|webConversationPreferences|modelCapabilities)$/.test(node.moduleSpecifier.text)) violations.push(node.moduleSpecifier.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps completion snapshots, live merges, unread tokens and acknowledgement ownership out of the parent', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const storage = /^(?:eventUnreadByThreadId|completionChangesDuringLoad|completionLoad|inFlightCompletionAcknowledgements|acknowledgedCompletionTokens|completionAcknowledgementGeneration)$/
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name
        && /^(?:loadCompletionList|markThreadAsRead|resetCompletionAcknowledgements|handleCompletionChange)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && storage.test(node.name.text)) violations.push(node.name.text)
      if (ts.isStringLiteral(node) && node.text === '/codex-api/thread-completions') violations.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps complete selection, projection and collaboration preferences in their owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const operations = /^(?:selectThread|setSelectedThreadId|primeSelectedThread|setSelectedCollaborationMode|setSelectedCollaborationModeForThread|loadSelectedThreadId|saveSelectedThreadId|loadSelectedCollaborationModeMap|saveSelectedCollaborationModeMap|readSelectedCollaborationMode|writeSelectedCollaborationModeForContext)$/
    const privateState = /^(?:threadSelectionRevision|threadSelectionStopped|selectedCollaborationModeByContext|allThreads)$/
    const projections = new Set(['selectedThreadId', 'selectedThread', 'selectedCollaborationMode'])
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && operations.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (privateState.test(node.name.text) || projections.has(node.name.text)) violations.push(node.name.text)
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let target: ts.Expression = node.left
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
        if (ts.isIdentifier(target) && projections.has(target.text)) violations.push(node.left.getText(source))
      }
      if (ts.isStringLiteral(node) && /codex-web-local\.(?:selected-thread-id|collaboration-mode)/.test(node.text)) violations.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps status revisions, complete turn transitions, persistence gates and overlay policy in the status owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const operations = /^(?:applyListedStatuses|setThreadInProgress|setThreadInProgressForTests|setTurnSummaryForThread|setTurnActivityForThread|setTurnErrorForThread|clearTransientTurnErrorForThread|clearAllTransientTurnErrors|clearCompletedTurnLiveState|blockInterruptUntilThreadIsPersisted|clearInterruptPersistenceGate|maybeUnblockInterruptForPersistedThread|maybeUnblockInterruptForActiveTurn|markServerListedThreads|markThreadMessagesPersisted|inferNextTurnIndex|setTurnIndexForThread|replaceTurnIndexLookupForThread|hasActiveInProgressThreads)$/
    const storage = /^(?:inProgressById|threadStatusRevision|turnIndexByTurnIdByThreadId|threadTurnOrderState|turnSummaryByThreadId|turnActivityByThreadId|turnErrorByThreadId|activeTurnIdByThreadId|threadActiveTurnState|interruptBlockedUntilPersistedByThreadId|threadListedByServerById|persistedUserMessageByThreadId|selectedLiveOverlay|isSelectedThreadInterruptPending)$/
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && operations.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && storage.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^createThread(?:TurnOrder|ActiveTurn)State$/.test(node.expression.text)) violations.push(node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps the sole notification stream, dispatch and reconnect policy in the subscription owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:stopNotificationStream|notificationReady|notificationLifecycleRevision)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && /^(?:subscribeCodexNotifications|subscribeRpcNotifications|observeTaskNotification)$/.test(node.expression.getText(source))) violations.push(node.expression.getText(source))
      if (ts.isStringLiteral(node) && /^(?:ready|codexapp\/(?:completions\/changed|queue\/changed|reconnected))$/.test(node.text)) violations.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps project organization, hydration, persistence and private storage in their owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const operations = /^(?:applyThreadFlags|insertOptimisticThread|currentThreadVersion|hydrateWorkspaceRootsStateIfNeeded|applyThreadGroups|removeArchivedThreadFromLoadedLists|persistProjectLabelToGlobalState|renameProject|removeProject|reorderProject|pinProjectToTop|persistProjectOrderToWorkspaceRoots|loadProjectOrder|saveProjectOrder|loadProjectDisplayNames|saveProjectDisplayNames)$/
    const storage = /^(?:sourceGroups|projectOrder|pendingListedThreadIds|hasHydratedWorkspaceRootsState|renameProjectTimer)$/
    const projections = new Set(['projectGroups', 'projectDisplayNameById'])
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && operations.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && storage.test(node.name.text)) violations.push(node.name.text)
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /projectGateway(?:\.js)?$/.test(node.moduleSpecifier.text)) violations.push(node.moduleSpecifier.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let target: ts.Expression = node.left
        while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression
        if (ts.isIdentifier(target) && projections.has(target.text)) violations.push(node.left.getText(source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps complete refresh policy and account/read revisions in their owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'refreshAll') violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && /^(?:accountIdentityRevision|threadReadLifecycleRevision)$/.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && /^(?:invalidateThreadResumeCache|isCodexCliMissingError)$/.test(node.expression.text)) violations.push(node.expression.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps usage, terminal persistence and snapshot writes in their owners', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const operations = /^(?:normalizeStoredTokenCount|asStoredRecord|normalizeStoredTokenUsageBreakdown|normalizeStoredThreadTokenUsage|loadThreadTokenUsageMap|saveThreadTokenUsageMap|loadThreadTerminalOpenMap|saveThreadTerminalOpenMap|setThreadTokenUsage|setThreadTerminalOpen|toggleSelectedThreadTerminal)$/
    const storage = /^(?:snapshotThreads|threadTokenUsageByThreadId|terminalOpenByThreadId|THREAD_TOKEN_USAGE_STORAGE_KEY|THREAD_TERMINAL_OPEN_STORAGE_KEY)$/
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && operations.test(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && storage.test(node.name.text)) violations.push(node.name.text)
      if (ts.isStringLiteral(node) && /thread-(?:token-usage|terminal-open)\.v1$/.test(node.text)) violations.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('keeps message composition, optimistic identity, ordinals and request ordering in the projection owner', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const operations = /^(?:appendOptimisticUserMessage|readNextUserMessageOrdinal|combineHistoryAndLive|hasEquivalentUserMessage|insertTurnSummaryMessage|readQuestionReply)$/
    const projections = /^(?:selectedAuthRecovery|isLoadingMessages|selectedThreadServerRequests|messages|hasMoreOlderMessages|isLoadingOlderMessages|threadSearchVersion)$/
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && operations.test(node.name.text)) violations.push(node.name.text)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && operations.test(node.expression.text)) violations.push(node.expression.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && projections.test(node.name.text)) violations.push(node.name.text)
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /(?:messageIdentity|turnSummary|userQuestions)$/.test(node.moduleSpecifier.text)) violations.push(node.moduleSpecifier.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it('limits the compatibility parent to assembly, shell errors and cross-owner lifecycle commands', () => {
    const source = readSource('useDesktopState.ts')
    const violations: string[] = []
    const glue = new Set(['useDesktopState', 'markThreadHistoryDirty', 'pruneThreadScopedState', 'setLiveAgentMessagesForThread',
      'clearLiveAgentMessagesForThread', 'rebindLiveFileChangeTurnIndices', 'removeLiveCommandsPersistedIn',
      'removeLiveFileChangesPersistedIn', 'clearRegisteredTimeouts', 'startPolling', 'stopPolling'])
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name && !glue.has(node.name.text)) violations.push(node.name.text)
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
        && /^(?:ref|shallowRef|reactive|shallowReactive|computed)$/.test(node.initializer.expression.getText(source))
        && !['error', 'codexCliMissingError'].includes(node.name.getText(source))) violations.push(node.name.getText(source))
      if (ts.isCallExpression(node) && /\.localStorage\./.test(node.expression.getText(source))) violations.push(node.expression.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })

  it.each(['threadHistoryController.ts', 'threadListController.ts', 'threadSynchronizationController.ts', 'threadRealtimeController.ts', 'threadPendingRequestController.ts', 'threadQueueController.ts', 'threadSendController.ts', 'threadMetadataController.ts', 'threadMutationController.ts', 'threadModelController.ts', 'threadCompletionController.ts', 'threadSelectionController.ts', 'threadStatusController.ts', 'threadSubscriptionController.ts', 'projectOrganizationController.ts', 'desktopRefreshController.ts', 'threadUsageController.ts', 'threadTerminalController.ts', 'threadConversationController.ts'])('uses narrow commands without parent imports or writable ref ports in %s', file => {
    const source = readSource(file)
    const violations: string[] = []
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && /(?:useDesktopState|codexGateway)(?:\.js)?$/.test(node.moduleSpecifier.text)) violations.push(node.moduleSpecifier.text)
      if (ts.isTypeAliasDeclaration(node) && /^(?:Thread(?:History|List|Synchronization|Realtime|PendingRequest|Queue|Send|Metadata|Mutation|Model|Completion|Selection|Status|Subscription|Usage|Terminal|Conversation)|ProjectOrganization|DesktopRefresh)ControllerOptions$/.test(node.name.text)) {
        function checkPort(port: ts.Node) {
          if (ts.isTypeReferenceNode(port) && /^(?:Ref|WritableComputedRef)$/.test(port.typeName.getText(source))) violations.push(port.getText(source))
          ts.forEachChild(port, checkPort)
        }
        checkPort(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(violations).toEqual([])
  })
})
