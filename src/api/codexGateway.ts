// Compatibility exports only. Production consumers use the domain entry points.

export { invalidateModelCatalog } from './modelCatalog'

export type { StoredQueuedMessage, ThreadQueueState } from '../threadQueue'

export type { ForkedThread, StartedThread } from './threadCommandGateway'

export {
  deleteProjectAutomation,
  deleteThreadAutomation,
  getProjectAutomationMap,
  getThreadAutomation,
  getThreadAutomationMap,
  runThreadAutomationNow,
  upsertProjectAutomation,
  upsertThreadAutomation,
} from './automationGateway'

export type { FileAttachmentParam } from './threadCommandGateway'

export {
  getAvailableModelIds,
  getAvailableModels,
  getCurrentModelConfig,
  interruptThreadTurn,
  startThreadTurn,
} from './threadCommandGateway'

export {
  archiveThread,
  forkThread,
  forkThreadAtTurn,
  renameThread,
  startThread,
  revertThreadFileChanges,
  updateThreadFileChanges,
} from './threadCommandGateway'

export type {
  ThreadTerminalAttachInput,
  ThreadTerminalQuickCommand,
  ThreadTerminalSession,
} from './terminalGateway'

export {
  attachThreadTerminal,
  closeThreadTerminal,
  getThreadTerminalQuickCommands,
  getThreadTerminalSnapshot,
  getThreadTerminalStatus,
  resizeThreadTerminal,
  sendThreadTerminalInput,
} from './terminalGateway'

export type {
  AccountLoginCompleteResult,
  AccountLoginStartResult,
  AccountLoginStatus,
  AccountSwitchResult,
  AccountsListResult,
} from './accountGateway'

export {
  cancelCodexLogin,
  completeCodexLogin,
  getAccountRateLimits,
  getAccounts,
  getCodexLoginStatus,
  normalizeAccountEntry,
  pickCodexRateLimitSnapshot,
  refreshAccountQuota,
  refreshAccountsFromAuth,
  removeAccount,
  startCodexLogin,
  switchAccount,
} from './accountGateway'

export { normalizeThreadModelFromPayload, normalizeThreadModelProviderFromPayload } from './threadModel'

export type { ThreadPinnedState, ThreadTitleCache } from './threadPreferencesGateway'

export {
  generateThreadTitle,
  getPinnedThreadState,
  getThreadTitleCache,
  persistPinnedThreadIds,
  persistThreadTitle,
} from './threadPreferencesGateway'

export type {
  ThreadGroupsPage,
  ThreadHistoryPosition,
  ThreadTurnPage,
  ResumedThread,
} from './threadReadGateway'

export {
  getBackgroundThreadListLimit,
  getThreadDetail,
  getThreadGroups,
  getThreadGroupsPage,
  getThreadMessages,
  getThreadSummary,
  getOlderThreadMessages,
  getThreadTurnMessages,
  invalidateThreadResumeCache,
  rollbackThread,
  resumeThread,
} from './threadReadGateway'

export type { WorkspaceRootsState } from './projectGateway'

export {
  assignConversationProject,
  getProjectDirectories,
  getHomeDirectory,
  getWorkspaceRootsState,
  importProjectZip,
  listLocalDirectories,
  searchComposerFiles,
  removeVirtualProject,
  setWorkspaceRootsState,
} from './projectGateway'

export type { LocalDirectoryEntry, LocalDirectoryListing } from './projectGateway'

export type { ComposerFileSuggestion } from './projectGateway'

export type { RpcNotification } from './codexRpcClient'

export {
  listDirectoryPlugins,
  readDirectoryPlugin,
  installDirectoryPlugin,
  uninstallDirectoryPlugin,
  setDirectoryPluginEnabled,
  listDirectoryApps,
  listInstalledDirectoryApps,
  directoryAppsFromRuntime,
  setDirectoryAppEnabled,
  listDirectoryMcpServers,
  reloadDirectoryMcpServers,
  startDirectoryMcpLogin,
  getFirstLaunchPluginsCardPreference,
  persistFirstLaunchPluginsCardPreference,
} from './directoryGateway'

export type {
  DirectoryPluginSummary,
  DirectoryPluginDetail,
  DirectoryPluginAppSummary,
  DirectoryPluginSkillSummary,
  DirectoryPluginInstallResult,
  DirectoryAppInfo,
  DirectoryMcpServerStatus,
  DirectoryMcpLoginResult,
  FirstLaunchPluginsCardPreference,
} from './directoryGateway'

export {
  getMethodCatalog,
  getNotificationCatalog,
  subscribeCodexNotifications,
  replyToServerRequest,
  getPendingServerRequests,
} from './runtimeGateway'

export {
  setDefaultModel,
  setCodexSpeedMode,
  getAvailableCollaborationModes,
} from './executionSettingsGateway'

export { getFreeModeStatus, setFreeMode, setFreeModeCustomKey, setCustomProvider } from './providerGateway'

export type { FreeModeStatus } from './providerGateway'

export { getThreadQueueState, getDeliveryStatuses, mutateThreadQueueState } from './threadQueueGateway'

export {
  createWorktree,
  createPermanentWorktree,
  getWorktreeBranchOptions,
  getGitBranchState,
  getGitRepositoryStatus,
  checkoutGitBranch,
  getGitBranchCommits,
  getGitCommitFiles,
  resetGitBranchToCommit,
} from './gitGateway'

export type {
  WorktreeCreateResult,
  WorktreeBranchOption,
  GitBranchState,
  GitCommitOption,
  GitCommitFileChange,
  GitRepositoryStatus,
} from './gitGateway'

export {
  getThreadReviewResult,
  getReviewSnapshot,
  getReviewSummary,
  applyReviewAction,
  initializeReviewGit,
  startThreadReview,
} from './reviewGateway'

export { searchThreads } from './threadSearchGateway'

export type { ThreadSearchResult } from './threadSearchGateway'

export { configureTelegramBot, getTelegramConfig, getTelegramStatus } from './telegramGateway'

export type { TelegramStatus, TelegramConfig } from './telegramGateway'

export { getSkillsList } from './skillsGateway'

export type { SkillInfo } from './skillsGateway'

export { getComposerPrompts, createComposerPrompt, removeComposerPrompt } from './composerPromptsGateway'

export type { ComposerPromptInfo } from './composerPromptsGateway'

export { uploadFile } from './mediaGateway'

export { getAccountRateLimitsResponse } from './accountGateway'
