import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { UiProjectGroup, UiThreadAutomation, UiThreadAutomationStatus } from '../types/codex'
import { accountDisplayName } from '../accountDisplay'
import { isVirtualProjectId } from '../projectOrganization'
import { isAbsoluteLikePath } from '../pathUtils.js'
import { displayTimeZone, browserTimeZone, formatLocalDateTime } from '../dateTime'
import { MAX_DAILY_TIMES, normalizeDailyTimes, buildDailyTimesRule, readDailyTimesRule } from '../automationDailyTimes'
import { reasoningUnavailable, fastModeControl, effortOptions, modelSettingsProblem, type ModelCapability } from '../modelCapabilities'
import { loadAutomationAccountModels } from '../api/automationAccountModels'
import { getThreadAutomationMap, getProjectAutomationMap, upsertThreadAutomation, upsertProjectAutomation, deleteThreadAutomation, deleteProjectAutomation, runAutomationNow, createAutomationRequestId } from '../api/automationGateway'

export type SidebarAutomationOptions = {
  getGroups: () => UiProjectGroup[]
  getAccounts: () => { storageId: string; alias?: string; email: string | null; accountId: string }[] | undefined
  getModels: () => string[] | undefined
  getModelCapabilities: () => ModelCapability[] | undefined
  getProjectCwd: (projectName: string) => string | undefined
  getProjectDisplayName: (projectName: string) => string
  t: (text: string, params?: Record<string, string | number>) => string
  closeProjectMenu: () => void
  closeThreadMenu: () => void
  removeProject: (projectName: string) => void
  automationsChanged: () => void
  notifyOperation: (message: string, kind?: 'success' | 'info' | 'warning' | 'error') => void
  recordVisibleFailure: (message: string) => void
}

type AutomationScheduleMode = 'daily' | 'interval' | 'advanced'
type AutomationIntervalUnit = 'minutes' | 'hours' | 'days'
type AutomationTargetMode = 'thread' | 'project'
type AutomationScheduleDraft = {
  mode: AutomationScheduleMode
  dailyTimes: string[]
  interval: number
  intervalUnit: AutomationIntervalUnit
}

export function createSidebarAutomationController({ getGroups, getAccounts, getModels, getModelCapabilities, getProjectCwd, getProjectDisplayName, t, closeProjectMenu, closeThreadMenu, removeProject, automationsChanged, notifyOperation, recordVisibleFailure }: SidebarAutomationOptions) {
  let sidebarStopped = false
  let started = false
  let accountModelsAbort: AbortController | null = null
  const automationByThreadId = ref<Record<string, UiThreadAutomation[]>>({})
  const automationByProjectName = ref<Record<string, UiThreadAutomation[]>>({})
  let automationMapsRevision = 0
  let projectAutomationReadGeneration = 0
  let projectAutomationReadFlight: { revision: number; promise: Promise<void> } | null = null
  const removingAutomationProjects = new Set<string>()
  const projectRemoval = ref('')
  const automationDialogVisible = ref(false)
  const automationRemoval = ref<{ scope: 'thread' | 'project'; threadId: string; projectName: string; automationId: string; name: string } | null>(null)
  const automationDialogScope = ref<'thread' | 'project'>('thread')
  const automationDialogThreadId = ref('')
  const automationDialogProjectName = ref('')
  const automationDialogAutomationId = ref('')
  const automationDialogMode = ref<'create' | 'edit'>('create')
  const automationTargetPickerVisible = ref(false)
  const automationTargetMode = ref<AutomationTargetMode>('thread')
  const automationTargetValue = ref('')
  const automationDialogError = ref('')
  const projectAutomationActionError = ref('')
  const isSavingAutomation = ref(false)
  const isRunningAutomation = ref(false)
  const automationTimezone = ref('')
  const stopTimezoneWatch = watch(automationDialogVisible, (visible) => {
    if (visible && !automationTimezone.value) automationTimezone.value = browserTimeZone()
  })
  const automationDraft = ref<{
    name: string
    prompt: string
    rrule: string
    status: UiThreadAutomationStatus
    model: string
    serviceTier: string
    accountStorageId: string
    protected: boolean
    reasoningEffort: string
  }>({
    name: '',
    prompt: '',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    status: 'ACTIVE', model: '', reasoningEffort: '', serviceTier: '', accountStorageId: '', protected: false,
  })
  const automationAccountOptions = computed(() => [{ value: '', label: t('跟随全局账号') }, ...(getAccounts() || []).map(account => ({ value: account.storageId, label: accountDisplayName(account) }))])
  const accountModels = ref<import('../modelCapabilities').ModelCapability[]>([])
  const accountModelsLoading = ref(false)
  const accountModelsError = ref('')
  let accountModelGeneration = 0
  const stopAccountModelsWatch = watch([automationDialogVisible, () => automationDraft.value.accountStorageId], async ([visible, storageId]) => {
    if (sidebarStopped) return
    accountModelsAbort?.abort()
    accountModelsAbort = null
    const generation = ++accountModelGeneration
    accountModels.value = []
    accountModelsError.value = ''
    accountModelsLoading.value = false
    if (!visible || !storageId) return
    accountModelsLoading.value = true
    try {
      const controller = new AbortController()
      accountModelsAbort = controller
      const rows = await loadAutomationAccountModels(storageId, controller.signal)
      if (generation !== accountModelGeneration || sidebarStopped) return
      accountModels.value = rows
    } catch {
      if (generation === accountModelGeneration) accountModelsError.value = '所选账号模型目录读取失败，请重新选择账号重试。'
    } finally {
      if (generation === accountModelGeneration) {
        accountModelsLoading.value = false
        accountModelsAbort = null
      }
    }
  }, { flush: 'sync' })
  const automationModelOptions = computed(() => [{ value: '', label: t('跟随运行时默认模型') }, ...(automationDraft.value.accountStorageId ? accountModels.value.map(model => model.id) : getModels() ?? []).map(value => ({ value, label: value }))])
  const automationModelCapability = computed(() => (automationDraft.value.accountStorageId ? accountModels.value : getModelCapabilities())?.find(model => model.id === automationDraft.value.model || (!automationDraft.value.model && model.isDefault)))
  const automationFastControl = computed(() => fastModeControl(automationModelCapability.value, automationDraft.value.serviceTier))
  const automationEffortOptions = computed(() => effortOptions(automationModelCapability.value, automationDraft.value.reasoningEffort))
  const automationScheduleDraft = ref<AutomationScheduleDraft>({
    mode: 'daily',
    dailyTimes: ['09:00'],
    interval: 1,
    intervalUnit: 'hours',
  })
  const automationDialogAutomations = computed(() => {
    if (automationDialogScope.value === 'project') {
      const projectName = automationDialogProjectName.value
      return projectName ? (automationByProjectName.value[projectName] ?? []) : []
    }
    const threadId = automationDialogThreadId.value
    return threadId ? (automationByThreadId.value[threadId] ?? []) : []
  })
  const automationSchedulePreview = computed(() => describeAutomationSchedule(automationDraft.value.rrule))
  const automationThreadTargetOptions = computed(() => {
    const rows: Array<{ value: string; label: string; searchText: string }> = []
    for (const group of getGroups()) {
      for (const thread of group.threads) {
        const title = thread.title?.trim() || thread.id
        const project = getProjectDisplayName(group.projectName)
        rows.push({
          value: thread.id,
          label: `${title} · ${project}`,
          searchText: `${title} ${project} ${thread.id}`.toLowerCase(),
        })
      }
    }
    return rows
  })
  const automationProjectTargetOptions = computed(() => {
    const rows: Array<{ value: string; label: string; searchText: string }> = []
    for (const group of getGroups()) {
      const cwd = getProjectAutomationKey(group.projectName)
      if (!cwd) continue
      const label = getProjectDisplayName(group.projectName)
      rows.push({
        value: cwd,
        label,
        searchText: `${label} ${cwd}`.toLowerCase(),
      })
    }
    return rows
  })
  const automationTargetDropdownOptions = computed(() => {
    const source = automationTargetMode.value === 'project'
      ? automationProjectTargetOptions.value
      : automationThreadTargetOptions.value
    return source.map((option) => ({ value: option.value, label: option.label }))
  })
  const automationIntervalUnitOptions = computed(() => [
    { value: 'minutes', label: t('minutes') },
    { value: 'hours', label: t('hours') },
    { value: 'days', label: t('days') },
  ])
  const automationStatusOptions = computed(() => [
    { value: 'ACTIVE', label: t('Active') },
    { value: 'PAUSED', label: t('Paused') },
  ])
  const stopTargetWatch = watch(automationTargetDropdownOptions, (options) => {
    if (!automationTargetPickerVisible.value) return
    if (options.some((option) => option.value === automationTargetValue.value)) return
    automationTargetValue.value = options[0]?.value ?? ''
  })

  function threadHasAutomation(threadId: string): boolean {
    return threadAutomationCount(threadId) > 0
  }

  function threadAutomationCount(threadId: string): number {
    return automationByThreadId.value[threadId]?.length ?? 0
  }

  function projectHasAutomation(projectName: string): boolean {
    return projectAutomationCount(projectName) > 0
  }

  function projectAutomationCount(projectName: string): number {
    const key = getProjectAutomationKey(projectName)
    return key ? (automationByProjectName.value[key]?.length ?? 0) : 0
  }

  function automationTooltip(automations: UiThreadAutomation[]): string {
    if (automations.length === 0) return ''
    if (automations.length > 1) {
      const activeCount = automations.filter((automation) => automation.status === 'ACTIVE').length
      return `${automations.length} automations • ${activeCount} active`
    }
    const [automation] = automations
    const nextRunLabel = automation.status === 'PAUSED'
      ? '-'
      : automation.nextRunAtMs
        ? formatLocalDateTime(automation.nextRunAtMs)
        : 'Not scheduled'
    return `${automation.name} • Next run: ${nextRunLabel}`
  }

  function threadAutomationTooltip(threadId: string): string {
    return automationTooltip(automationByThreadId.value[threadId] ?? [])
  }

  function projectAutomationTooltip(projectName: string): string {
    const key = getProjectAutomationKey(projectName)
    return automationTooltip(key ? (automationByProjectName.value[key] ?? []) : [])
  }

  function parsePositiveInteger(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(1, Math.floor(parsed))
  }

  function buildIntervalRrule(interval: number, unit: AutomationIntervalUnit): string {
    const normalizedInterval = parsePositiveInteger(interval, 1)
    if (unit === 'minutes') return `FREQ=MINUTELY;INTERVAL=${normalizedInterval}`
    if (unit === 'hours') return `FREQ=HOURLY;INTERVAL=${normalizedInterval}`
    return `FREQ=DAILY;INTERVAL=${normalizedInterval}`
  }

  function parseRruleParts(rrule: string): Record<string, string> {
    return Object.fromEntries(
      rrule
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [key, ...rest] = part.split('=')
          return [key.toUpperCase(), rest.join('=').trim()]
        })
        .filter(([key, value]) => key && value),
    )
  }

  function createScheduleDraftFromRrule(rrule: string): AutomationScheduleDraft {
    const parts = parseRruleParts(rrule)
    const frequency = parts.FREQ?.toUpperCase()
    const interval = parsePositiveInteger(parts.INTERVAL, 1)
    const dailyTimes = readDailyTimesRule(rrule)
    if (dailyTimes) return { mode: 'daily', dailyTimes, interval: 1, intervalUnit: 'hours' }
    if (!rrule.includes('\n') && Object.keys(parts).every(key => ['FREQ', 'INTERVAL'].includes(key)) && (frequency === 'MINUTELY' || frequency === 'HOURLY' || (frequency === 'DAILY' && parts.INTERVAL !== undefined))) {
      return {
        mode: 'interval',
        dailyTimes: ['09:00'],
        interval,
        intervalUnit: frequency === 'MINUTELY' ? 'minutes' : frequency === 'HOURLY' ? 'hours' : 'days',
      }
    }
    return {
      mode: 'advanced',
      dailyTimes: ['09:00'],
      interval: 1,
      intervalUnit: 'hours',
    }
  }

  function describeAutomationSchedule(rrule: string): string {
    const parts = parseRruleParts(rrule)
    const frequency = parts.FREQ?.toUpperCase()
    const interval = parsePositiveInteger(parts.INTERVAL, 1)
    const dailyTimes = readDailyTimesRule(rrule)
    if (dailyTimes) return `${t('Run every day at')} ${dailyTimes.join('、')}`
    if (frequency === 'MINUTELY') return t('RRULE: {rrule} · runs every {count} minutes', { rrule, count: interval })
    if (frequency === 'HOURLY') return t('RRULE: {rrule} · runs every {count} hours', { rrule, count: interval })
    if (frequency === 'DAILY' && parts.INTERVAL !== undefined) return t('RRULE: {rrule} · runs every {count} days', { rrule, count: interval })
    return rrule ? `RRULE: ${rrule}` : t('RRULE is required.')
  }

  function syncAutomationRruleFromScheduleDraft(): void {
    const draft = automationScheduleDraft.value
    if (draft.mode === 'daily') {
      try {
        automationDraft.value.rrule = buildDailyTimesRule(draft.dailyTimes)
        automationDialogError.value = ''
      } catch (cause) {
        automationDialogError.value = cause instanceof Error ? cause.message : '时间格式应为 HH:mm'
      }
    } else if (draft.mode === 'interval') {
      automationDraft.value.rrule = buildIntervalRrule(draft.interval, draft.intervalUnit)
    }
  }

  function addAutomationDailyTime(): void {
    const times = automationScheduleDraft.value.dailyTimes
    if (times.length >= MAX_DAILY_TIMES) return
    for (let hour = 8; hour < 32; hour++) {
      const time = `${String(hour % 24).padStart(2, '0')}:00`
      if (!times.includes(time)) {
        times.push(time)
        syncAutomationRruleFromScheduleDraft()
        return
      }
    }
  }

  function removeAutomationDailyTime(index: number): void {
    automationScheduleDraft.value.dailyTimes.splice(index, 1)
    syncAutomationRruleFromScheduleDraft()
  }

  function onAutomationIntervalUnitChange(value: string): void {
    if (value !== 'minutes' && value !== 'hours' && value !== 'days') return
    automationScheduleDraft.value = {
      ...automationScheduleDraft.value,
      intervalUnit: value,
    }
    syncAutomationRruleFromScheduleDraft()
  }

  function onAutomationStatusChange(value: string): void {
    if (value !== 'ACTIVE' && value !== 'PAUSED') return
    automationDraft.value = {
      ...automationDraft.value,
      status: value,
    }
  }

  function syncAutomationScheduleDraftFromRrule(): void {
    automationScheduleDraft.value = createScheduleDraftFromRrule(automationDraft.value.rrule)
  }

  function setAutomationScheduleMode(mode: AutomationScheduleMode): void {
    automationScheduleDraft.value = {
      ...automationScheduleDraft.value,
      mode,
    }
    syncAutomationRruleFromScheduleDraft()
  }

  function openAutomationDialog(threadId: string): void {
    if (sidebarStopped || isSavingAutomation.value || isRunningAutomation.value) return
    automationDialogScope.value = 'thread'
    automationDialogThreadId.value = threadId
    automationDialogProjectName.value = ''
    automationTargetPickerVisible.value = false
    automationDialogError.value = ''

    const existing = automationByThreadId.value[threadId]?.[0]
    if (existing) {
      selectAutomationForEditing(existing.id)
    } else {
      startNewAutomationDraft()
    }
    automationDialogVisible.value = true
    closeThreadMenu()
  }

  function openProjectAutomationDialog(projectName: string): void {
    if (sidebarStopped || isSavingAutomation.value || isRunningAutomation.value) return
    const projectCwd = getProjectAutomationKey(projectName)
    if (removingAutomationProjects.has(projectCwd)) return
    if (!projectCwd) {
      automationDialogScope.value = 'project'
      automationDialogThreadId.value = ''
      automationDialogProjectName.value = ''
      automationTargetPickerVisible.value = false
      automationDialogError.value = 'Project automation requires a resolved absolute project path.'

      automationDialogVisible.value = true
      closeProjectMenu()
      return
    }
    automationDialogScope.value = 'project'
    automationDialogThreadId.value = ''
    automationDialogProjectName.value = projectCwd
    automationTargetPickerVisible.value = false
    automationDialogError.value = ''

    const existing = automationByProjectName.value[projectCwd]?.[0]
    if (existing) {
      selectAutomationForEditing(existing.id)
    } else {
      startNewAutomationDraft()
    }
    automationDialogVisible.value = true
    closeProjectMenu()
  }

  function openAutomationEditorFromPanel(payload: {
    scope: 'thread' | 'project'
    target: string
    automation: UiThreadAutomation
  }): void {
    if (sidebarStopped || isSavingAutomation.value || isRunningAutomation.value) return
    if (payload.scope === 'project' && removingAutomationProjects.has(payload.target)) return
    automationMapsRevision += 1
    automationDialogScope.value = payload.scope
    automationDialogThreadId.value = payload.scope === 'thread' ? payload.target : ''
    automationDialogProjectName.value = payload.scope === 'project' ? payload.target : ''
    automationTargetPickerVisible.value = false
    automationDialogError.value = ''

    if (payload.scope === 'project') {
      automationByProjectName.value = updateAutomationForProject(automationByProjectName.value, payload.target, payload.automation)
    } else {
      automationByThreadId.value = updateAutomationForThread(automationByThreadId.value, payload.target, payload.automation)
    }
    selectAutomationForEditing(payload.automation.id)
    automationDialogVisible.value = true
    closeProjectMenu()
    closeThreadMenu()
  }

  function openAutomationCreatorFromPanel(): void {
    if (sidebarStopped || isSavingAutomation.value || isRunningAutomation.value) return
    automationTargetPickerVisible.value = true
    automationTargetMode.value = 'thread'
    automationTargetValue.value = automationThreadTargetOptions.value[0]?.value ?? ''
    automationDialogScope.value = 'thread'
    automationDialogThreadId.value = ''
    automationDialogProjectName.value = ''
    automationDialogError.value = ''

    startNewAutomationDraft()
    automationDialogVisible.value = true
    closeProjectMenu()
    closeThreadMenu()
  }

  function setAutomationTargetMode(mode: AutomationTargetMode): void {
    if (sidebarStopped || isSavingAutomation.value || isRunningAutomation.value) return
    automationTargetMode.value = mode
    automationTargetValue.value = ''
    automationDialogScope.value = mode === 'project' ? 'project' : 'thread'
    automationTargetValue.value = automationTargetDropdownOptions.value[0]?.value ?? ''
  }

  function startNewAutomationDraft(): void {
    automationTimezone.value = ''
    automationDialogAutomationId.value = ''
    automationDialogMode.value = 'create'
    automationDialogError.value = ''

    automationDraft.value = {
      name: automationDialogScope.value === 'project' ? 'Project automation' : 'Thread automation',
      prompt: '',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      status: 'ACTIVE', model: '', reasoningEffort: '', serviceTier: '', accountStorageId: '', protected: false,
    }
    automationScheduleDraft.value = createScheduleDraftFromRrule(automationDraft.value.rrule)
  }

  function selectAutomationForEditing(automationId: string): void {
    const existing = automationDialogAutomations.value.find((automation) => automation.id === automationId)
    if (!existing) return
    automationDialogAutomationId.value = existing.id
    automationDialogMode.value = 'edit'
    automationDialogError.value = ''

    automationTimezone.value = existing.timezone ?? ''
    automationDraft.value = {
      name: existing.name,
      prompt: existing.prompt,
      rrule: existing.rrule,
      status: existing.status,
      model: existing.model ?? '', reasoningEffort: existing.reasoningEffort ?? '', serviceTier: existing.serviceTier ?? '', accountStorageId: existing.accountStorageId || '', protected: existing.protected === true,
    }
    automationScheduleDraft.value = createScheduleDraftFromRrule(existing.rrule)
  }

  function closeAutomationDialog(): void {
    if (isSavingAutomation.value || isRunningAutomation.value) return
    automationRemoval.value = null
    automationDialogVisible.value = false
    automationDialogScope.value = 'thread'
    automationDialogThreadId.value = ''
    automationDialogProjectName.value = ''
    automationDialogAutomationId.value = ''
    automationDialogError.value = ''

    isSavingAutomation.value = false
    isRunningAutomation.value = false
  }

  function omitAutomationThread(state: Record<string, UiThreadAutomation[]>, threadId: string): Record<string, UiThreadAutomation[]> {
    return Object.fromEntries(Object.entries(state).filter(([id]) => id !== threadId))
  }

  function updateAutomationForThread(
    state: Record<string, UiThreadAutomation[]>,
    threadId: string,
    saved: UiThreadAutomation,
  ): Record<string, UiThreadAutomation[]> {
    const existing = state[threadId] ?? []
    const index = existing.findIndex((automation) => automation.id === saved.id)
    const next = [...existing]
    if (index >= 0) {
      next.splice(index, 1, saved)
    } else {
      next.push(saved)
    }
    return { ...state, [threadId]: next }
  }

  function removeAutomationForThread(
    state: Record<string, UiThreadAutomation[]>,
    threadId: string,
    automationId: string,
  ): Record<string, UiThreadAutomation[]> {
    const next = (state[threadId] ?? []).filter((automation) => automation.id !== automationId)
    return next.length > 0 ? { ...state, [threadId]: next } : omitAutomationThread(state, threadId)
  }

  function omitAutomationProject(state: Record<string, UiThreadAutomation[]>, projectName: string): Record<string, UiThreadAutomation[]> {
    return Object.fromEntries(Object.entries(state).filter(([name]) => name !== projectName))
  }

  function updateAutomationForProject(
    state: Record<string, UiThreadAutomation[]>,
    projectName: string,
    saved: UiThreadAutomation,
  ): Record<string, UiThreadAutomation[]> {
    const existing = state[projectName] ?? []
    const index = existing.findIndex((automation) => automation.id === saved.id)
    const next = [...existing]
    if (index >= 0) {
      next.splice(index, 1, saved)
    } else {
      next.push(saved)
    }
    return { ...state, [projectName]: next }
  }

  function reloadProjectAutomations(): Promise<void> {
    if (sidebarStopped) return Promise.resolve()
    const revision = automationMapsRevision
    if (projectAutomationReadFlight?.revision === revision) return projectAutomationReadFlight.promise
    const generation = ++projectAutomationReadGeneration
    const flight = { revision, promise: Promise.resolve() }
    flight.promise = (async () => {
      try {
        const rows = await getProjectAutomationMap()
        if (sidebarStopped || revision !== automationMapsRevision || generation !== projectAutomationReadGeneration) return
        automationByProjectName.value = Object.fromEntries(Object.entries(rows).filter(([key]) => !removingAutomationProjects.has(key)))
      } finally {
        if (projectAutomationReadFlight === flight) projectAutomationReadFlight = null
      }
    })()
    projectAutomationReadFlight = flight
    return flight.promise
  }

  async function submitAutomationDialog(): Promise<void> {
    if (sidebarStopped || isSavingAutomation.value || isRunningAutomation.value) return
    let threadId = automationDialogThreadId.value
    let projectName = automationDialogProjectName.value
    isSavingAutomation.value = true
    automationDialogError.value = ''

    try {
      if (automationScheduleDraft.value.mode === 'daily') normalizeDailyTimes(automationScheduleDraft.value.dailyTimes)
      syncAutomationRruleFromScheduleDraft()
      if (automationTargetPickerVisible.value && automationDialogMode.value === 'create') {
        if (automationTargetMode.value === 'thread') {
          threadId = automationTargetValue.value
          projectName = ''
          automationDialogScope.value = 'thread'
          automationDialogThreadId.value = threadId
          automationDialogProjectName.value = ''
        } else {
          projectName = automationTargetValue.value
          threadId = ''
          automationDialogScope.value = 'project'
          automationDialogThreadId.value = ''
          automationDialogProjectName.value = projectName
        }
      }
      if (automationDialogScope.value === 'thread' && !threadId) {
        throw new Error('Select a chat target for this automation')
      }
      if (automationDialogScope.value === 'project' && !projectName) {
        throw new Error('Select a project target for this automation')
      }
      if (automationDialogScope.value === 'project' && removingAutomationProjects.has(projectName)) return
      if (accountModelsLoading.value || accountModelsError.value) throw new Error(accountModelsError.value || '正在读取所选账号模型目录')
      if (automationDraft.value.accountStorageId && automationDraft.value.model && !accountModels.value.some(model => model.id === automationDraft.value.model)) throw new Error('所选账号不支持此模型，请重新选择')
      const modelProblem = modelSettingsProblem(automationModelCapability.value, automationDraft.value.reasoningEffort, automationDraft.value.serviceTier)
      if (modelProblem) throw new Error(modelProblem)
      const input = {
        id: automationDialogAutomationId.value || undefined,
        name: automationDraft.value.name,
        prompt: automationDraft.value.prompt,
        rrule: automationDraft.value.rrule,
        timezone: displayTimeZone(),
        status: automationDraft.value.status,
        accountStorageId: automationDraft.value.accountStorageId || null, protected: automationModelCapability.value?.providerId === 'custom' ? false : automationDraft.value.protected,
        model: automationDraft.value.model || null, reasoningEffort: reasoningUnavailable(automationModelCapability.value) ? null : automationDraft.value.reasoningEffort || null, serviceTier: automationModelCapability.value?.providerId === 'custom' && !automationModelCapability.value.serviceTiers?.length ? null : automationDraft.value.serviceTier || null,
      }
      const scope = automationDialogScope.value
      automationMapsRevision += 1
      const saved = scope === 'project'
        ? await upsertProjectAutomation({ ...input, projectName })
        : await upsertThreadAutomation({ ...input, threadId })
      if (sidebarStopped) return
      automationMapsRevision += 1
      if (scope === 'project') {
        automationByProjectName.value = updateAutomationForProject(automationByProjectName.value, projectName, saved)
      } else {
        automationByThreadId.value = updateAutomationForThread(automationByThreadId.value, threadId, saved)
      }
      automationsChanged()
      selectAutomationForEditing(saved.id)
      notifyOperation('自动化已保存', 'success')
      isSavingAutomation.value = false
    } catch (error) {
      if (sidebarStopped) return
      notifyOperation(error instanceof Error ? error.message : 'Failed to save automation')
    } finally {
      isSavingAutomation.value = false
    }
  }

  function requestDeleteAutomationFromDialog(): void {
    if (sidebarStopped || isSavingAutomation.value || isRunningAutomation.value || !automationDialogAutomationId.value) return
    automationRemoval.value = {
      scope: automationDialogScope.value,
      threadId: automationDialogThreadId.value,
      projectName: automationDialogProjectName.value,
      automationId: automationDialogAutomationId.value,
      name: automationDialogAutomations.value.find(row => row.id === automationDialogAutomationId.value)?.name || automationDraft.value.name,
    }
  }

  async function onDeleteAutomationFromDialog(): Promise<void> {
    const target = automationRemoval.value
    if (sidebarStopped || !target || isSavingAutomation.value || isRunningAutomation.value) return
    const { threadId, projectName, automationId } = target
    if (!automationId) return
    if (target.scope === 'thread' && !threadId) return
    if (target.scope === 'project' && !projectName) return
    isSavingAutomation.value = true
    automationDialogError.value = ''

    try {
      automationMapsRevision += 1
      if (target.scope === 'project') {
        await deleteProjectAutomation(projectName, automationId)
        if (sidebarStopped) return
        automationByProjectName.value = {
          ...automationByProjectName.value,
          [projectName]: (automationByProjectName.value[projectName] ?? []).filter(row => row.id !== automationId),
        }
      } else {
        await deleteThreadAutomation(threadId, automationId)
        if (sidebarStopped) return
        automationByThreadId.value = removeAutomationForThread(automationByThreadId.value, threadId, automationId)
      }
      automationMapsRevision += 1
      automationsChanged()
      isSavingAutomation.value = false
      closeAutomationDialog()
      notifyOperation('自动化任务已移除', 'success')
    } catch (error) {
      if (sidebarStopped) return
      notifyOperation(error instanceof Error ? error.message : 'Failed to remove automation')
    } finally {
      isSavingAutomation.value = false
    }
  }

  async function onRunAutomationFromDialog(): Promise<void> {
    const threadId = automationDialogThreadId.value
    const automationId = automationDialogAutomationId.value
    const target = automationDialogScope.value === 'project' ? automationDialogProjectName.value : threadId
    if (sidebarStopped || !target || !automationId || isSavingAutomation.value || isRunningAutomation.value) return
    isRunningAutomation.value = true
    automationDialogError.value = ''

    try {
      await runAutomationNow({ automationId, target, kind: automationDialogScope.value === 'project' ? 'cron' : 'heartbeat', requestId: createAutomationRequestId() })
      if (sidebarStopped) return
      notifyOperation('自动化已加入队列', 'info')
    } catch (error) {
      if (sidebarStopped) return
      notifyOperation(error instanceof Error ? error.message : 'Failed to run automation')
    } finally {
      isRunningAutomation.value = false
    }
  }

  function setAutomationMaps(maps: { thread: Record<string, UiThreadAutomation[]>; project: Record<string, UiThreadAutomation[]> }): void {
    if (sidebarStopped) return
    automationMapsRevision += 1
    automationByThreadId.value = maps.thread
    automationByProjectName.value = maps.project
  }

  function onRemoveProject(projectName: string): void {
    if (sidebarStopped) return
    if (!isVirtualProjectId(projectName) && projectHasAutomation(projectName)) {
      projectRemoval.value = projectName
      closeProjectMenu()
      return
    }
    removeProjectAndAutomations(projectName)
  }

  function confirmRemoveProjectAndAutomations(): void {
    const projectName = projectRemoval.value
    if (!projectName) return
    projectRemoval.value = ''
    removeProjectAndAutomations(projectName)
  }

  function removeProjectAndAutomations(projectName: string): void {
    if (sidebarStopped) return
    const projectCwd = getProjectAutomationKey(projectName)
    if (removingAutomationProjects.has(projectCwd)) return
    if ((isSavingAutomation.value || isRunningAutomation.value) && automationDialogScope.value === 'project' && automationDialogProjectName.value === projectCwd) return
    removeProject(projectName)
    // Removing an organization only ungroups conversations. Its task definition
    // and execution identity must survive just like the underlying working data.
    if (!isVirtualProjectId(projectName) && projectCwd && projectHasAutomation(projectName)) {
      projectAutomationActionError.value = ''
      const previousRows = automationByProjectName.value[projectCwd]
      removingAutomationProjects.add(projectCwd)
      automationMapsRevision += 1
      automationByProjectName.value = omitAutomationProject(automationByProjectName.value, projectCwd)
      void deleteProjectAutomation(projectCwd)
        .then(async () => {
          if (sidebarStopped) return
          try {
            await reloadProjectAutomations()
            if (sidebarStopped) return
            notifyOperation('自动化任务已移除', 'success')
          } catch {
            if (sidebarStopped) return
            projectAutomationActionError.value = '自动化任务已移除，但列表刷新失败。'
            notifyOperation(projectAutomationActionError.value, 'warning')
          }
        })
        .catch(async (error) => {
          if (sidebarStopped) return
          removingAutomationProjects.delete(projectCwd)
          if (!automationByProjectName.value[projectCwd] && previousRows) {
            automationMapsRevision += 1
            automationByProjectName.value = { ...automationByProjectName.value, [projectCwd]: previousRows }
          }
          const message = error instanceof Error ? error.message : 'Failed to delete project automation'
          projectAutomationActionError.value = message
          recordVisibleFailure(message)
          try {
            await reloadProjectAutomations()
          } catch {
            // The target-only rollback already preserved unrelated changes.
          }
        })
        .finally(() => {
          removingAutomationProjects.delete(projectCwd)
          if (sidebarStopped) return
          automationsChanged()
        })
    }
    closeProjectMenu()
  }

  function getProjectAutomationKey(projectName: string): string {
    if (isVirtualProjectId(projectName)) return projectName
    const projectCwd = getProjectCwd(projectName)?.trim() ?? ''
    return isAbsoluteLikePath(projectCwd) ? projectCwd : ''
  }
  async function start(): Promise<void> {
    if (started || sidebarStopped) return
    started = true
    const revision = automationMapsRevision
    try {
      const rows = await getThreadAutomationMap()
      if (sidebarStopped) return
      if (revision === automationMapsRevision) automationByThreadId.value = rows
    } catch {
      if (sidebarStopped) return
    }
    if (revision === automationMapsRevision) {
      try {
        await reloadProjectAutomations()
      } catch {
        // Keep newer panel and operation snapshots when startup reads fail.
      }
    }
  }
  function removeArchivedThreadAutomations(threadId: string): void {
    if (sidebarStopped || !threadHasAutomation(threadId)) return
    automationMapsRevision += 1
    void deleteThreadAutomation(threadId).catch(() => undefined)
    automationByThreadId.value = omitAutomationThread(automationByThreadId.value, threadId)
  }
  function cancelProjectRemoval(): void {
    projectRemoval.value = ''
  }
  function cancelAutomationRemoval(): void {
    if (isSavingAutomation.value || isRunningAutomation.value) return
    automationRemoval.value = null
  }
  function stop(): void {
    if (sidebarStopped) return
    sidebarStopped = true
    accountModelGeneration += 1
    accountModelsAbort?.abort()
    accountModelsAbort = null
    projectAutomationReadFlight = null
    stopTimezoneWatch()
    stopAccountModelsWatch()
    stopTargetWatch()
  }
  return {
    automationByThreadId: computed(() => automationByThreadId.value),
    automationByProjectName: computed(() => automationByProjectName.value),
    projectRemoval: computed(() => projectRemoval.value),
    automationDialogVisible: computed(() => automationDialogVisible.value),
    automationRemoval: computed(() => automationRemoval.value),
    automationDialogScope: computed(() => automationDialogScope.value),
    automationDialogThreadId: computed(() => automationDialogThreadId.value),
    automationDialogProjectName: computed(() => automationDialogProjectName.value),
    automationDialogAutomationId: computed(() => automationDialogAutomationId.value),
    automationDialogMode: computed(() => automationDialogMode.value),
    automationTargetPickerVisible: computed(() => automationTargetPickerVisible.value),
    automationTargetMode: computed(() => automationTargetMode.value),
    automationDialogError: computed(() => automationDialogError.value),
    projectAutomationActionError: computed(() => projectAutomationActionError.value),
    isSavingAutomation: computed(() => isSavingAutomation.value),
    isRunningAutomation: computed(() => isRunningAutomation.value),
    accountModels: computed(() => accountModels.value),
    accountModelsLoading: computed(() => accountModelsLoading.value),
    accountModelsError: computed(() => accountModelsError.value),
    automationDraft,
    automationScheduleDraft,
    automationTargetValue,
    automationAccountOptions,
    automationModelOptions,
    automationModelCapability,
    automationFastControl,
    automationEffortOptions,
    automationDialogAutomations,
    automationSchedulePreview,
    automationTargetDropdownOptions,
    automationIntervalUnitOptions,
    automationStatusOptions,
    threadHasAutomation,
    threadAutomationCount,
    projectHasAutomation,
    projectAutomationCount,
    threadAutomationTooltip,
    projectAutomationTooltip,
    syncAutomationRruleFromScheduleDraft,
    addAutomationDailyTime,
    removeAutomationDailyTime,
    onAutomationIntervalUnitChange,
    onAutomationStatusChange,
    syncAutomationScheduleDraftFromRrule,
    setAutomationScheduleMode,
    openAutomationDialog,
    openProjectAutomationDialog,
    openAutomationEditorFromPanel,
    openAutomationCreatorFromPanel,
    setAutomationTargetMode,
    selectAutomationForEditing,
    closeAutomationDialog,
    reloadProjectAutomations,
    submitAutomationDialog,
    requestDeleteAutomationFromDialog,
    onDeleteAutomationFromDialog,
    onRunAutomationFromDialog,
    setAutomationMaps,
    onRemoveProject,
    confirmRemoveProjectAndAutomations,
    removeProjectAndAutomations,
    start,
    stop,
    removeArchivedThreadAutomations,
    cancelProjectRemoval,
    cancelAutomationRemoval,
  }
}

export function useSidebarAutomationController(options: SidebarAutomationOptions) {
  const controller = createSidebarAutomationController(options)
  onMounted(() => { void controller.start() })
  onBeforeUnmount(controller.stop)
  return controller
}
