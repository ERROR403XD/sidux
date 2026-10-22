import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationModeKind, UiRateLimitSnapshot } from '../types/codex'
import type { SkillInfo } from '../api/skillsGateway'
import { createThreadMetadataController } from './threadMetadataController'

const api = vi.hoisted(() => ({
  getAccountRateLimits: vi.fn(), getAvailableCollaborationModes: vi.fn(), getSkillsList: vi.fn(),
  generateThreadTitle: vi.fn(), getThreadTitleCache: vi.fn(), persistThreadTitle: vi.fn(),
}))
vi.mock('../api/accountGateway', () => ({ getAccountRateLimits: api.getAccountRateLimits }))
vi.mock('../api/executionSettingsGateway', () => ({ getAvailableCollaborationModes: api.getAvailableCollaborationModes }))
vi.mock('../api/skillsGateway', () => ({ getSkillsList: api.getSkillsList }))
vi.mock('../api/threadPreferencesGateway', () => ({
  generateThreadTitle: api.generateThreadTitle, getThreadTitleCache: api.getThreadTitleCache, persistThreadTitle: api.persistThreadTitle,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const quota = (limitId: string): UiRateLimitSnapshot => ({ limitId, limitName: null, primary: null, secondary: null, credits: null, planType: null })
const skill = (name: string): SkillInfo => ({ name, path: `/${name}/SKILL.md`, scope: 'user', description: '', enabled: true })

function setup() {
  let accountRevision = 0
  let cwd = '/project'
  let mode: CollaborationModeKind = 'plan'
  let timerId = 0
  const callbacks = new Map<number, { callback: () => void; delay: number }>()
  const activeTimers = new Set<number>()
  vi.stubGlobal('window', {
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId
      callbacks.set(id, { callback, delay })
      activeTimers.add(id)
      return id
    },
    clearTimeout: (id: number) => activeTimers.delete(id),
  })
  const onTitlesChanged = vi.fn()
  const markHistoryDirty = vi.fn()
  const syncFromNotifications = vi.fn().mockResolvedValue(undefined)
  const refreshModels = vi.fn().mockResolvedValue(undefined)
  const controller = createThreadMetadataController({
    getAccountRevision: () => accountRevision,
    getSelectedCwd: () => cwd,
    getCollaborationMode: () => mode,
    setCollaborationMode: value => { mode = value },
    refreshModels, onTitlesChanged, markHistoryDirty, syncFromNotifications,
  })
  return {
    controller, callbacks, activeTimers, onTitlesChanged, markHistoryDirty, syncFromNotifications, refreshModels,
    getMode: () => mode,
    setCwd: (value: string) => { cwd = value },
    switchAccount: () => { accountRevision++; controller.invalidateForAccountChange() },
    run: (id: number) => { activeTimers.delete(id); callbacks.get(id)!.callback() },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  api.getSkillsList.mockResolvedValue([])
  api.getAccountRateLimits.mockResolvedValue(null)
  api.getAvailableCollaborationModes.mockResolvedValue([{ value: 'default', label: 'Default' }, { value: 'plan', label: 'Plan' }])
  api.getThreadTitleCache.mockResolvedValue({ titles: {} })
  api.persistThreadTitle.mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('metadata resource owner', () => {
  it('coalesces quota reads, preserves a newer live update and reuses the warm result', async () => {
    const test = setup()
    const read = deferred<UiRateLimitSnapshot>()
    api.getAccountRateLimits.mockReturnValueOnce(read.promise)
    const first = test.controller.refreshRateLimits()
    const joined = test.controller.refreshRateLimits()
    test.controller.markQuotaUpdated()
    test.controller.observeQuota(quota('live'))
    read.resolve(quota('snapshot'))
    await Promise.all([first, joined])
    await test.controller.refreshRateLimits()
    expect(api.getAccountRateLimits).toHaveBeenCalledOnce()
    expect(test.controller.quota.value?.limitId).toBe('live')
    expect(test.controller.accountRateLimitSnapshots.value).toEqual([quota('live')])
    test.controller.invalidateQuotaCache()
    api.getAccountRateLimits.mockResolvedValueOnce(quota('fresh'))
    await test.controller.refreshRateLimits()
    expect(api.getAccountRateLimits).toHaveBeenCalledTimes(2)
    expect(test.controller.quota.value?.limitId).toBe('fresh')
  })

  it.each(['stop', 'account'])('keeps current quota and skill slots across stale finally after %s', async transition => {
    const test = setup()
    const oldQuota = deferred<UiRateLimitSnapshot>()
    const newQuota = deferred<UiRateLimitSnapshot>()
    const oldSkills = deferred<SkillInfo[]>()
    const newSkills = deferred<SkillInfo[]>()
    api.getAccountRateLimits.mockReturnValueOnce(oldQuota.promise).mockReturnValueOnce(newQuota.promise)
    api.getSkillsList.mockReturnValueOnce(oldSkills.promise).mockReturnValueOnce(newSkills.promise)
    const old = [test.controller.refreshRateLimits(), test.controller.refreshSkills()]
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    const current = [test.controller.refreshRateLimits(), test.controller.refreshSkills()]
    oldQuota.resolve(quota('old'))
    oldSkills.resolve([skill('old')])
    await Promise.all(old)
    const joiners = [test.controller.refreshRateLimits(), test.controller.refreshSkills()]
    expect(api.getAccountRateLimits).toHaveBeenCalledTimes(2)
    expect(api.getSkillsList).toHaveBeenCalledTimes(2)
    newQuota.resolve(quota('current'))
    newSkills.resolve([skill('current')])
    await Promise.all([...current, ...joiners])
    expect(test.controller.quota.value?.limitId).toBe('current')
    expect(test.controller.installedSkills.value.map(row => row.name)).toEqual(['current'])
  })

  it('scopes skill reads to cwd, reuses an empty warm result and retains known data on failure', async () => {
    const test = setup()
    const old = deferred<SkillInfo[]>()
    api.getSkillsList.mockReturnValueOnce(old.promise)
    const reading = test.controller.refreshSkills()
    test.setCwd('  /other  ')
    await test.controller.refreshSkills()
    old.resolve([skill('old')])
    await reading
    await test.controller.refreshSkills()
    expect(api.getSkillsList.mock.calls).toEqual([[['/project']], [['/other']]])
    expect(test.controller.installedSkills.value).toEqual([])
    api.getSkillsList.mockResolvedValueOnce([skill('known')])
    await test.controller.refreshSkills({ force: true })
    api.getSkillsList.mockRejectedValueOnce(new Error('offline'))
    await test.controller.refreshSkills({ force: true })
    expect(test.controller.installedSkills.value.map(row => row.name)).toEqual(['known'])
  })

  it('rejects stale modes, applies current fallback and preserves choices on transient failure', async () => {
    const test = setup()
    const old = deferred<unknown[]>()
    api.getAvailableCollaborationModes.mockReturnValueOnce(old.promise)
    const reading = test.controller.refreshCollaborationModes()
    test.switchAccount()
    old.resolve([{ value: 'default', label: 'Obsolete' }])
    await reading
    expect(test.getMode()).toBe('plan')
    api.getAvailableCollaborationModes.mockResolvedValueOnce([{ value: 'default', label: 'Current' }])
    await test.controller.refreshCollaborationModes()
    expect(test.getMode()).toBe('default')
    api.getAvailableCollaborationModes.mockRejectedValueOnce(new Error('offline'))
    await test.controller.refreshCollaborationModes()
    expect(test.controller.availableCollaborationModes.value[0]?.label).toBe('Current')
  })

  it('protects live titles during cache reads and accepts only the latest cache generation', async () => {
    const test = setup()
    const older = deferred<{ titles: Record<string, string> }>()
    const newer = deferred<{ titles: Record<string, string> }>()
    api.getThreadTitleCache.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const oldRead = test.controller.loadThreadTitleCacheIfNeeded({ force: true })
    const newRead = test.controller.loadThreadTitleCacheIfNeeded({ force: true })
    test.controller.setTitle('renamed', 'Confirmed')
    newer.resolve({ titles: { renamed: 'Earlier', other: 'Current cache' } })
    await newRead
    older.resolve({ titles: { other: 'Obsolete cache' } })
    await oldRead
    expect(test.controller.getTitle('renamed')).toBe('Confirmed')
    expect(test.controller.getTitle('other')).toBe('Current cache')
    await test.controller.loadThreadTitleCacheIfNeeded()
    expect(api.getThreadTitleCache).toHaveBeenCalledTimes(2)
    expect(test.onTitlesChanged).not.toHaveBeenCalled()
  })

  it('bounds generated title input, persists the fallback and does not overwrite a live title', async () => {
    const test = setup()
    const title = deferred<string>()
    api.generateThreadTitle.mockReturnValueOnce(title.promise)
    const generating = test.controller.requestThreadTitleGeneration('generated', 'x'.repeat(400), '/project')
    expect(api.generateThreadTitle).toHaveBeenCalledWith('x'.repeat(300), '/project')
    test.controller.setTitle('generated', 'Live')
    title.resolve('Generated')
    await generating
    expect(api.persistThreadTitle).not.toHaveBeenCalled()
    await test.controller.requestThreadTitleGeneration('attachment', '', '/project', '  Image  ')
    expect(api.persistThreadTitle).toHaveBeenCalledWith('attachment', 'Image')
    expect(test.onTitlesChanged).toHaveBeenCalledOnce()
    api.generateThreadTitle.mockResolvedValueOnce('Current generation')
    await test.controller.requestThreadTitleGeneration('current', 'prompt', null)
    expect(test.controller.getTitle('current')).toBe('Current generation')
    expect(test.onTitlesChanged).toHaveBeenCalledTimes(2)
  })

  it.each(['stop', 'account'])('does not commit or persist old title operations after %s', async transition => {
    const test = setup()
    const cache = deferred<{ titles: Record<string, string> }>()
    const title = deferred<string>()
    api.getThreadTitleCache.mockReturnValueOnce(cache.promise)
    api.generateThreadTitle.mockReturnValueOnce(title.promise)
    const operations = [test.controller.loadThreadTitleCacheIfNeeded(), test.controller.requestThreadTitleGeneration('generated', 'prompt', null)]
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    cache.resolve({ titles: { cached: 'Old' } })
    title.resolve('Old')
    await Promise.all(operations)
    expect(test.controller.getTitle('cached')).toBe('')
    expect(test.controller.getTitle('generated')).toBe('')
    expect(api.persistThreadTitle).not.toHaveBeenCalled()
    expect(test.onTitlesChanged).not.toHaveBeenCalled()
  })

  it('owns all timers and ignores retained callbacks across ten stop/start cycles', async () => {
    const test = setup()
    for (let cycle = 0; cycle < 10; cycle++) {
      test.controller.scheduleAncillaryStateRefresh()
      test.controller.scheduleRateLimitRefresh()
      test.controller.scheduleDelayedTurnSync('thread')
      const oldIds = [...test.activeTimers]
      expect(oldIds.map(id => test.callbacks.get(id)!.delay)).toEqual([0, 500, 3000])
      const isCurrent = test.controller.captureContext()
      test.controller.stop()
      expect(test.activeTimers.size).toBe(0)
      expect(isCurrent()).toBe(false)
      test.controller.start()
      test.controller.scheduleDelayedTurnSync('thread')
      const current = [...test.activeTimers][0]!
      oldIds.forEach(test.run)
      expect(test.activeTimers.has(current)).toBe(true)
      expect(test.markHistoryDirty).not.toHaveBeenCalled()
      test.run(current)
      expect(test.markHistoryDirty).toHaveBeenCalledWith('thread')
      expect(test.syncFromNotifications).toHaveBeenCalledOnce()
      test.markHistoryDirty.mockClear()
      test.syncFromNotifications.mockClear()
    }
    expect(api.getSkillsList).not.toHaveBeenCalled()
    expect(api.getAccountRateLimits).not.toHaveBeenCalled()
    expect(test.refreshModels).not.toHaveBeenCalled()
  })

  it('debounces ancillary and quota refresh and cancels turn follow-up after a completion', async () => {
    const test = setup()
    test.controller.scheduleAncillaryStateRefresh()
    test.controller.scheduleAncillaryStateRefresh({ providerChanged: true, includeProviderModels: true })
    test.controller.scheduleRateLimitRefresh()
    test.controller.scheduleRateLimitRefresh()
    test.controller.scheduleDelayedTurnSync('thread')
    test.controller.clearDelayedTurnSync('thread')
    expect([...test.activeTimers].map(id => test.callbacks.get(id)!.delay)).toEqual([0, 500])
    api.getSkillsList.mockRejectedValueOnce(new Error('optional metadata offline'))
    for (const id of [...test.activeTimers]) test.run(id)
    await Promise.resolve()
    await Promise.resolve()
    expect(test.refreshModels).toHaveBeenCalledWith({ providerChanged: true, includeProviderModels: true })
    expect(api.getAccountRateLimits).toHaveBeenCalledOnce()
    expect(api.getSkillsList).toHaveBeenCalledOnce()
    expect(api.getAvailableCollaborationModes).toHaveBeenCalledOnce()
    expect(test.syncFromNotifications).not.toHaveBeenCalled()
  })

  it('retains same-account skill and mode snapshots on stop and clears account data on invalidation', async () => {
    const test = setup()
    api.getSkillsList.mockResolvedValueOnce([skill('known')])
    await test.controller.refreshSkills()
    test.controller.observeQuota(quota('known'))
    test.controller.setTitle('thread', 'Known')
    test.controller.stop()
    expect(test.controller.quota.value).toBeNull()
    expect(test.controller.getTitle('thread')).toBe('')
    expect(test.controller.accountRateLimitSnapshots.value).toEqual([quota('known')])
    expect(test.controller.installedSkills.value.map(row => row.name)).toEqual(['known'])
    await test.controller.refreshAncillaryState()
    expect(test.refreshModels).not.toHaveBeenCalled()
    test.controller.start()
    test.switchAccount()
    expect(test.controller.installedSkills.value).toEqual([])
    expect(test.controller.accountRateLimitSnapshots.value).toEqual([])
    if (false) {
      // @ts-expect-error consumers cannot replace owner projections
      test.controller.quota.value = null
      // @ts-expect-error consumers cannot append to owner arrays
      test.controller.installedSkills.value.push(skill('external'))
      // @ts-expect-error consumers cannot replace mode choices
      test.controller.availableCollaborationModes.value = []
    }
  })
})
