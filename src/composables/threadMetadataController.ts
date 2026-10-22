import { computed, ref } from 'vue'
import { getAccountRateLimits } from '../api/accountGateway'
import { getAvailableCollaborationModes } from '../api/executionSettingsGateway'
import { getSkillsList, type SkillInfo } from '../api/skillsGateway'
import { generateThreadTitle, getThreadTitleCache, persistThreadTitle } from '../api/threadPreferencesGateway'
import type { CollaborationModeKind, CollaborationModeOption, UiProjectGroup, UiRateLimitSnapshot } from '../types/codex'

const RATE_LIMIT_REFRESH_DEBOUNCE_MS = 500
const TURN_START_FOLLOW_UP_SYNC_DELAY_MS = 3000
const RECENT_SKILLS_LOAD_REUSE_MS = 2000

type AncillaryRefreshOptions = { providerChanged?: boolean; includeProviderModels?: boolean }
export type ThreadMetadataControllerOptions = {
  getAccountRevision: () => number
  getSelectedCwd: () => string
  getCollaborationMode: () => CollaborationModeKind
  setCollaborationMode: (mode: CollaborationModeKind) => void
  refreshModels: (options: AncillaryRefreshOptions) => Promise<void>
  onTitlesChanged: () => void
  markHistoryDirty: (threadId: string) => void
  syncFromNotifications: () => Promise<void>
}

export function createThreadMetadataController({
  getAccountRevision, getSelectedCwd, getCollaborationMode, setCollaborationMode,
  refreshModels, onTitlesChanged, markHistoryDirty, syncFromNotifications,
}: ThreadMetadataControllerOptions) {
  const availableCollaborationModes = ref<CollaborationModeOption[]>([
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' },
  ])
  const codexRateLimit = ref<UiRateLimitSnapshot | null>(null)
  const installedSkills = ref<SkillInfo[]>([])
  const accountRateLimitSnapshots = ref<UiRateLimitSnapshot[]>([])
  const threadTitleById = ref<Record<string, string>>({})
  let rateLimitUpdateRevision = 0
  let recentRateLimitsAt = 0
  let rateLimitRefreshTimer: number | null = null
  let ancillaryStateRefreshTimer: number | null = null
  const delayedTurnSyncTimerByThreadId = new Map<string, number>()
  let metadataStopped = false
  let metadataLifecycleRevision = 0
  let titleCacheReadGeneration = 0
  let refreshSkillsPromise: { promise: Promise<void>; key: string; isCurrent: () => boolean } | null = null
  let hasLoadedSkills = false
  let lastSkillsLoadAt = 0
  let lastSkillsLoadKey = ''
  let rateLimitRefreshPromise: { promise: Promise<void>; isCurrent: () => boolean } | null = null

  function captureMetadataContext(): () => boolean {
    const identityRevision = getAccountRevision()
    const lifecycleRevision = metadataLifecycleRevision
    return () => !metadataStopped && identityRevision === getAccountRevision() && lifecycleRevision === metadataLifecycleRevision
  }

  function resetMetadataReads(accountChanged = false): void {
    refreshSkillsPromise = null
    rateLimitRefreshPromise = null
    hasLoadedSkills = false
    lastSkillsLoadAt = 0
    lastSkillsLoadKey = ''
    recentRateLimitsAt = 0
    if (accountChanged) {
      installedSkills.value = []
      codexRateLimit.value = null
      accountRateLimitSnapshots.value = []
      threadTitleById.value = {}
    }
  }

  function setCodexRateLimit(nextSnapshot: UiRateLimitSnapshot | null): void {
    codexRateLimit.value = nextSnapshot
  }

  async function refreshCollaborationModes(): Promise<void> {
    const isCurrent = captureMetadataContext()
    if (!isCurrent()) return
    try {
      const modes = await getAvailableCollaborationModes()
      if (!isCurrent()) return
      availableCollaborationModes.value = modes
      if (!modes.some((mode) => mode.value === getCollaborationMode())) {
        setCollaborationMode('default')
      }
    } catch {
      // Keep the last known collaboration mode choices on transient failures.
    }
  }

  async function refreshRateLimits(): Promise<void> {
    const isCurrent = captureMetadataContext()
    if (!isCurrent()) return
    if (Date.now() - recentRateLimitsAt < 2000) return
    if (rateLimitRefreshPromise?.isCurrent()) {
      await rateLimitRefreshPromise.promise
      return
    }

    const request = { promise: Promise.resolve(), isCurrent }
    rateLimitRefreshPromise = request
    request.promise = (async () => {
      try {
        const revision = rateLimitUpdateRevision
        const snapshot = await getAccountRateLimits()
        if (!isCurrent()) return
        recentRateLimitsAt = Date.now()
        if (revision === rateLimitUpdateRevision) setCodexRateLimit(snapshot)
        accountRateLimitSnapshots.value = codexRateLimit.value ? [codexRateLimit.value] : []
      } catch {
        // Keep the last known rate-limit state if the endpoint is temporarily unavailable.
      } finally {
        if (rateLimitRefreshPromise === request) rateLimitRefreshPromise = null
      }
    })()

    await request.promise
  }

  function scheduleRateLimitRefresh(): void {
    const isCurrent = captureMetadataContext()
    if (!isCurrent()) return
    recentRateLimitsAt = 0
    if (typeof window === 'undefined') {
      void refreshRateLimits()
      return
    }

    if (rateLimitRefreshTimer !== null) {
      window.clearTimeout(rateLimitRefreshTimer)
    }

    const timerId = window.setTimeout(() => {
      if (!isCurrent() || rateLimitRefreshTimer !== timerId) return
      rateLimitRefreshTimer = null
      void refreshRateLimits()
    }, RATE_LIMIT_REFRESH_DEBOUNCE_MS)
    rateLimitRefreshTimer = timerId
  }

  function clearDelayedTurnSync(threadId: string): void {
    if (!threadId || typeof window === 'undefined') return
    const timerId = delayedTurnSyncTimerByThreadId.get(threadId)
    if (timerId === undefined) return
    window.clearTimeout(timerId)
    delayedTurnSyncTimerByThreadId.delete(threadId)
  }

  function scheduleDelayedTurnSync(threadId: string): void {
    const isCurrent = captureMetadataContext()
    if (!isCurrent()) return
    if (!threadId || typeof window === 'undefined') return
    clearDelayedTurnSync(threadId)
    const timerId = window.setTimeout(() => {
      if (!isCurrent() || delayedTurnSyncTimerByThreadId.get(threadId) !== timerId) return
      delayedTurnSyncTimerByThreadId.delete(threadId)
      markHistoryDirty(threadId)
      void syncFromNotifications()
    }, TURN_START_FOLLOW_UP_SYNC_DELAY_MS)
    delayedTurnSyncTimerByThreadId.set(threadId, timerId)
  }

  function applyCachedTitlesToGroups(groups: UiProjectGroup[]): UiProjectGroup[] {
    const titles = threadTitleById.value
    if (Object.keys(titles).length === 0) return groups
    return groups.map((group) => ({
      projectName: group.projectName,
      threads: group.threads.map((thread) => {
        const cached = titles[thread.id]
        return cached ? { ...thread, title: cached } : thread
      }),
    }))
  }

  async function loadThreadTitleCacheIfNeeded(options: { force?: boolean } = {}): Promise<void> {
    const isCurrent = captureMetadataContext()
    if (!isCurrent()) return
    if (options.force !== true && Object.keys(threadTitleById.value).length > 0) return
    const generation = ++titleCacheReadGeneration
    const titlesAtStart = threadTitleById.value
    try {
      const cache = await getThreadTitleCache()
      if (!isCurrent() || generation !== titleCacheReadGeneration) return
      if (Object.keys(cache.titles).length > 0) {
        const titles = { ...cache.titles }
        // A later rename or live title takes precedence over this read snapshot.
        for (const [threadId, title] of Object.entries(threadTitleById.value)) {
          if (title !== titlesAtStart[threadId]) titles[threadId] = title
        }
        threadTitleById.value = titles
      }
    } catch {
      // Title cache is optional; keep UI functional.
    }
  }

  async function requestThreadTitleGeneration(threadId: string, prompt: string, cwd: string | null, fallbackTitle = ''): Promise<void> {
    const isCurrent = captureMetadataContext()
    if (!isCurrent()) return
    if (threadTitleById.value[threadId]) return
    const trimmed = prompt.trim()
    if (!trimmed) {
      // Attachment-only send: no prompt to summarize, so fall back to the
      // attachment-derived label and persist it — otherwise the title cache
      // never fills and the thread shows the raw scaffold title after reload.
      const fallback = fallbackTitle.trim()
      if (!fallback) return
      threadTitleById.value = { ...threadTitleById.value, [threadId]: fallback }
      onTitlesChanged()
      void persistThreadTitle(threadId, fallback)
      return
    }
    const truncated = trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed
    try {
      const title = await generateThreadTitle(truncated, cwd)
      if (!isCurrent()) return
      if (!title || threadTitleById.value[threadId]) return
      threadTitleById.value = { ...threadTitleById.value, [threadId]: title }
      onTitlesChanged()
      void persistThreadTitle(threadId, title)
    } catch {
      // Title generation is best-effort.
    }
  }

  async function refreshSkills(options: { force?: boolean } = {}): Promise<void> {
    const isContextCurrent = captureMetadataContext()
    if (!isContextCurrent()) return
    const selectedCwd = getSelectedCwd().trim()
    const isCurrent = () => isContextCurrent() && selectedCwd === (getSelectedCwd().trim())
    const skillsLoadKey = selectedCwd || '__global__'
    if (refreshSkillsPromise?.isCurrent() && refreshSkillsPromise.key === skillsLoadKey) {
      await refreshSkillsPromise.promise
      return
    }
    if (
      options.force !== true &&
      hasLoadedSkills &&
      lastSkillsLoadKey === skillsLoadKey &&
      Date.now() - lastSkillsLoadAt < RECENT_SKILLS_LOAD_REUSE_MS
    ) {
      return
    }

    const request = { promise: Promise.resolve(), key: skillsLoadKey, isCurrent }
    refreshSkillsPromise = request
    request.promise = (async () => {
      try {
        const skills = await getSkillsList(selectedCwd ? [selectedCwd] : undefined)
        if (!isCurrent()) return
        installedSkills.value = skills
        hasLoadedSkills = true
        lastSkillsLoadAt = Date.now()
        lastSkillsLoadKey = skillsLoadKey
      } catch {
        // keep previous skills on failure
      } finally {
        if (refreshSkillsPromise === request) refreshSkillsPromise = null
      }
    })()

    await request.promise
  }

  async function refreshAncillaryState(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): Promise<void> {
    if (!captureMetadataContext()()) return
    await Promise.allSettled([
      refreshModels({
        providerChanged: options.providerChanged,
        includeProviderModels: options.includeProviderModels,
      }),
      refreshRateLimits(),
      refreshCollaborationModes(),
      refreshSkills(),
    ])
  }

  function scheduleAncillaryStateRefresh(
    options: { providerChanged?: boolean; includeProviderModels?: boolean } = {},
  ): void {
    const isCurrent = captureMetadataContext()
    if (!isCurrent()) return
    const run = () => {
      if (!isCurrent()) return
      void refreshAncillaryState(options)
    }

    if (typeof window === 'undefined') {
      run()
      return
    }

    if (ancillaryStateRefreshTimer !== null) window.clearTimeout(ancillaryStateRefreshTimer)
    const timerId = window.setTimeout(() => {
      if (!isCurrent() || ancillaryStateRefreshTimer !== timerId) return
      ancillaryStateRefreshTimer = null
      run()
    }, 0)
    ancillaryStateRefreshTimer = timerId
  }

  function setTitle(threadId: string, title: string): void {
    threadTitleById.value = { ...threadTitleById.value, [threadId]: title }
  }

  function observeQuota(snapshot: UiRateLimitSnapshot | null): void {
    setCodexRateLimit(snapshot)
    accountRateLimitSnapshots.value = codexRateLimit.value ? [codexRateLimit.value] : []
  }

  function clearTimers(): void {
    if (typeof window !== 'undefined') {
      if (rateLimitRefreshTimer !== null) window.clearTimeout(rateLimitRefreshTimer)
      if (ancillaryStateRefreshTimer !== null) window.clearTimeout(ancillaryStateRefreshTimer)
      for (const timerId of delayedTurnSyncTimerByThreadId.values()) window.clearTimeout(timerId)
    }
    rateLimitRefreshTimer = null
    ancillaryStateRefreshTimer = null
    delayedTurnSyncTimerByThreadId.clear()
  }

  function stop(): void {
    metadataLifecycleRevision++
    metadataStopped = true
    resetMetadataReads()
    clearTimers()
    threadTitleById.value = {}
    codexRateLimit.value = null
  }

  return {
    availableCollaborationModes: computed(() => availableCollaborationModes.value as readonly CollaborationModeOption[]),
    installedSkills: computed(() => installedSkills.value as readonly SkillInfo[]),
    accountRateLimitSnapshots: computed(() => accountRateLimitSnapshots.value as readonly UiRateLimitSnapshot[]),
    quota: computed(() => codexRateLimit.value),
    getTitle: (threadId: string) => threadTitleById.value[threadId] || '',
    setTitle,
    persistTitle: persistThreadTitle,
    applyCachedTitlesToGroups,
    loadThreadTitleCacheIfNeeded,
    requestThreadTitleGeneration,
    refreshSkills,
    refreshCollaborationModes,
    refreshRateLimits,
    refreshAncillaryState,
    scheduleAncillaryStateRefresh,
    scheduleRateLimitRefresh,
    scheduleDelayedTurnSync,
    clearDelayedTurnSync,
    observeQuota,
    markQuotaUpdated: () => { rateLimitUpdateRevision += 1 },
    invalidateQuotaCache: () => { recentRateLimitsAt = 0 },
    captureContext: captureMetadataContext,
    invalidateForAccountChange: () => resetMetadataReads(true),
    start: () => { metadataStopped = false },
    stop,
  }
}
