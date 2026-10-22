import * as vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSidebarAutomationController } from './sidebarAutomationController'
import type { UiThreadAutomation } from '../types/codex'

const api = vi.hoisted(() => ({
  getThreadAutomationMap: vi.fn(), getProjectAutomationMap: vi.fn(),
  upsertThreadAutomation: vi.fn(), upsertProjectAutomation: vi.fn(),
  deleteThreadAutomation: vi.fn(), deleteProjectAutomation: vi.fn(), runAutomationNow: vi.fn(),
}))
vi.mock('../api/automationGateway', async importOriginal => ({
  ...await importOriginal<typeof import('../api/automationGateway')>(), ...api,
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve() }
const scopes: vue.EffectScope[] = []
function automation(id: string, kind: 'cron' | 'heartbeat' = 'cron'): UiThreadAutomation {
  return { id, kind, name: id, prompt: 'fixture prompt', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', status: 'PAUSED', targetThreadId: null, cwds: [], createdAtMs: null, updatedAtMs: null, nextRunAtMs: null }
}

function setup() {
  const emit = vi.fn()
  const notify = vi.fn()
  const scope = vue.effectScope()
  scopes.push(scope)
  const controller = scope.run(() => createSidebarAutomationController({
    getGroups: () => [], getAccounts: () => [], getModels: () => [], getModelCapabilities: () => [],
    getProjectCwd: name => ({ a: '/fixture/a', b: '/fixture/b' })[name as 'a' | 'b'],
    getProjectDisplayName: name => name, t: text => text,
    closeProjectMenu: vi.fn(), closeThreadMenu: vi.fn(),
    removeProject: name => emit('remove-project', name), automationsChanged: () => emit('automations-changed'),
    notifyOperation: notify, recordVisibleFailure: notify,
  }))!
  return { controller, emit, notify, mount: controller.start, stop: () => { controller.stop(); scope.stop() } }
}

beforeEach(() => {
  Object.values(api).forEach(mock => mock.mockReset())
  api.getThreadAutomationMap.mockResolvedValue({})
  api.getProjectAutomationMap.mockResolvedValue({})
  api.deleteProjectAutomation.mockResolvedValue(undefined)
  api.deleteThreadAutomation.mockResolvedValue(undefined)
  api.runAutomationNow.mockResolvedValue(undefined)
  api.upsertProjectAutomation.mockResolvedValue(automation('saved'))
  api.upsertThreadAutomation.mockResolvedValue(automation('saved', 'heartbeat'))

})
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals() })

describe('Sidebar automation and project operation composition', () => {
  it('does not launch automation reads after the sidebar has unmounted during startup', async () => {
    const waiting = deferred<Record<string, UiThreadAutomation[]>>()
    api.getThreadAutomationMap.mockReturnValueOnce(waiting.promise)
    const { mount, stop } = setup()
    const starting = mount()
    stop()
    const readsAtStop = api.getThreadAutomationMap.mock.calls.length + api.getProjectAutomationMap.mock.calls.length
    waiting.resolve({ t: [automation('late', 'heartbeat')] })
    await starting
    expect(api.getThreadAutomationMap.mock.calls.length + api.getProjectAutomationMap.mock.calls.length).toBe(readsAtStop)
  })

  it('retains maps pushed by the automation panel when an older startup read completes', async () => {
    const waiting = deferred<Record<string, UiThreadAutomation[]>>()
    api.getThreadAutomationMap.mockReturnValueOnce(waiting.promise)
    const { controller, mount } = setup()
    const starting = mount()
    await flush()
    controller.setAutomationMaps({ thread: { t: [automation('new', 'heartbeat')] }, project: { '/fixture/b': [automation('panel')] } })
    waiting.resolve({ t: [automation('old', 'heartbeat')] })
    await starting
    expect(controller.automationByThreadId.value.t?.[0]?.id).toBe('new')
    expect(controller.automationByProjectName.value['/fixture/b']?.[0]?.id).toBe('panel')
  })

  it('keeps a saving editor on its captured project and prevents duplicate saves and runs', async () => {
    const waiting = deferred<UiThreadAutomation>()
    api.upsertProjectAutomation.mockReturnValueOnce(waiting.promise)
    const { controller } = setup()
    controller.openAutomationEditorFromPanel({ scope: 'project', target: '/fixture/a', automation: automation('a') })
    const saving = controller.submitAutomationDialog()
    controller.openAutomationEditorFromPanel({ scope: 'thread', target: 't', automation: automation('t', 'heartbeat') })
    const duplicate = controller.submitAutomationDialog()
    await controller.onRunAutomationFromDialog()
    waiting.resolve(automation('a'))
    await Promise.all([saving, duplicate])
    expect(api.upsertThreadAutomation).not.toHaveBeenCalled()
    expect(api.runAutomationNow).not.toHaveBeenCalled()
    expect(controller.automationDialogScope.value).toBe('project')
    expect(controller.automationByThreadId.value['']).toBeUndefined()
    expect(controller.automationByProjectName.value['/fixture/a']?.[0]?.id).toBe('a')
  })

  it('does not publish, notify or mutate after a save settles after unmount', async () => {
    const waiting = deferred<UiThreadAutomation>()
    api.upsertProjectAutomation.mockReturnValueOnce(waiting.promise)
    const { controller, emit, notify, stop } = setup()
    controller.openAutomationEditorFromPanel({ scope: 'project', target: '/fixture/a', automation: automation('a') })
    const saving = controller.submitAutomationDialog()
    stop()
    waiting.resolve(automation('late'))
    await saving
    expect(controller.automationByProjectName.value['/fixture/a'].map((row: UiThreadAutomation) => row.id)).toEqual(['a'])
    expect(emit).not.toHaveBeenCalledWith('automations-changed')
    expect(notify).not.toHaveBeenCalled()
  })

  it('rolls back only the removed project when delete and refresh fail', async () => {
    const waiting = deferred<void>()
    api.deleteProjectAutomation.mockReturnValueOnce(waiting.promise)
    api.getProjectAutomationMap.mockRejectedValueOnce(new Error('refresh failed'))
    const { controller } = setup()
    controller.setAutomationMaps({ thread: {}, project: { '/fixture/a': [automation('a')], '/fixture/b': [automation('old-b')] } })
    controller.removeProjectAndAutomations('a')
    controller.openAutomationEditorFromPanel({ scope: 'project', target: '/fixture/b', automation: automation('new-b') })
    waiting.reject(new Error('delete failed'))
    await flush()
    expect(controller.automationByProjectName.value['/fixture/a']?.[0]?.id).toBe('a')
    expect(controller.automationByProjectName.value['/fixture/b'].map((row: UiThreadAutomation) => row.id)).toContain('new-b')
  })

  it('does not let a project refresh overwrite a newer panel map', async () => {
    const waiting = deferred<Record<string, UiThreadAutomation[]>>()
    api.getProjectAutomationMap.mockReturnValueOnce(waiting.promise)
    const { controller } = setup()
    const reading = controller.reloadProjectAutomations()
    controller.setAutomationMaps({ thread: {}, project: { '/fixture/a': [automation('new')] } })
    waiting.resolve({ '/fixture/a': [automation('old')] })
    await reading
    expect(controller.automationByProjectName.value['/fixture/a']?.[0]?.id).toBe('new')
  })

  it('ignores a selected account model response after unmount', async () => {
    const waiting = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(waiting.promise))
    const { controller, stop } = setup()
    controller.openAutomationDialog('t')
    controller.automationDraft.value.accountStorageId = 'fixture-account'
    await vue.nextTick()
    stop()
    waiting.resolve(new Response(JSON.stringify({ data: [{ id: 'late-model' }], source: 'codex' })))
    await flush()
    expect(controller.accountModels.value).toEqual([])
  })

  it('coalesces project map readers within the same revision', async () => {
    const waiting = deferred<Record<string, UiThreadAutomation[]>>()
    api.getProjectAutomationMap.mockReturnValueOnce(waiting.promise)
    const { controller } = setup()
    const first = controller.reloadProjectAutomations()
    const second = controller.reloadProjectAutomations()
    waiting.resolve({ '/fixture/a': [automation('a')] })
    await Promise.all([first, second])
    expect(api.getProjectAutomationMap).toHaveBeenCalledOnce()
  })

  it('starts once and cannot restart after disposal', async () => {
    const { controller, stop } = setup()
    await Promise.all([controller.start(), controller.start()])
    stop()
    stop()
    await controller.start()
    await controller.reloadProjectAutomations()
    controller.openAutomationDialog('t')
    expect(api.getThreadAutomationMap).toHaveBeenCalledOnce()
    expect(api.getProjectAutomationMap).toHaveBeenCalledOnce()
    expect(controller.automationDialogVisible.value).toBe(false)
  })

  it('requires project removal confirmation and preserves organization task identities', async () => {
    const { controller, emit } = setup()
    const organization = 'virtual:02200000-0000-0000-0000-000000000001'
    api.getProjectAutomationMap.mockResolvedValue({ [organization]: [automation('organization')] })
    controller.setAutomationMaps({ thread: {}, project: { '/fixture/a': [automation('a')], [organization]: [automation('organization')] } })
    controller.onRemoveProject('a')
    expect(emit).not.toHaveBeenCalled()
    controller.cancelProjectRemoval()
    expect(api.deleteProjectAutomation).not.toHaveBeenCalled()
    controller.onRemoveProject('a')
    controller.confirmRemoveProjectAndAutomations()
    await flush()
    expect(api.deleteProjectAutomation).toHaveBeenCalledWith('/fixture/a')
    controller.onRemoveProject(organization)
    expect(emit).toHaveBeenCalledWith('remove-project', organization)
    expect(controller.automationByProjectName.value[organization]?.[0]?.id).toBe('organization')
    expect(api.deleteProjectAutomation).toHaveBeenCalledTimes(1)
  })

  it('removes only the confirmed definition and blocks save or run during removal', async () => {
    const waiting = deferred<void>()
    api.deleteProjectAutomation.mockReturnValueOnce(waiting.promise)
    const { controller } = setup()
    controller.setAutomationMaps({ thread: {}, project: { '/fixture/a': [automation('a'), automation('b')] } })
    controller.openAutomationEditorFromPanel({ scope: 'project', target: '/fixture/a', automation: automation('a') })
    controller.requestDeleteAutomationFromDialog()
    const deleting = controller.onDeleteAutomationFromDialog()
    await controller.submitAutomationDialog()
    await controller.onRunAutomationFromDialog()
    controller.cancelAutomationRemoval()
    expect(controller.automationRemoval.value?.automationId).toBe('a')
    waiting.resolve()
    await deleting
    expect(api.upsertProjectAutomation).not.toHaveBeenCalled()
    expect(api.runAutomationNow).not.toHaveBeenCalled()
    expect(controller.automationByProjectName.value['/fixture/a']?.map(row => row.id)).toEqual(['b'])
    expect(controller.automationDialogVisible.value).toBe(false)
  })

  it('keeps delete failures retryable and suppresses late failures after stop', async () => {
    const { controller, notify, stop } = setup()
    controller.openAutomationEditorFromPanel({ scope: 'thread', target: 't', automation: automation('a', 'heartbeat') })
    controller.requestDeleteAutomationFromDialog()
    api.deleteThreadAutomation.mockRejectedValueOnce(new Error('delete blocked'))
    await controller.onDeleteAutomationFromDialog()
    expect(controller.automationRemoval.value?.automationId).toBe('a')
    expect(controller.isSavingAutomation.value).toBe(false)
    expect(notify).toHaveBeenCalledWith('delete blocked')
    const waiting = deferred<void>()
    api.deleteThreadAutomation.mockReturnValueOnce(waiting.promise)
    const deleting = controller.onDeleteAutomationFromDialog()
    stop()
    notify.mockClear()
    waiting.reject(new Error('late failure'))
    await deleting
    expect(notify).not.toHaveBeenCalled()
    expect(controller.automationByThreadId.value.t?.[0]?.id).toBe('a')
  })

  it('runs once with the captured target and prevents removal during the run', async () => {
    const waiting = deferred<void>()
    api.runAutomationNow.mockReturnValueOnce(waiting.promise)
    const { controller, emit } = setup()
    controller.openAutomationEditorFromPanel({ scope: 'project', target: '/fixture/a', automation: automation('a') })
    const running = controller.onRunAutomationFromDialog()
    await controller.onRunAutomationFromDialog()
    controller.removeProjectAndAutomations('a')
    controller.closeAutomationDialog()
    expect(controller.automationDialogVisible.value).toBe(true)
    waiting.resolve()
    await running
    expect(api.runAutomationNow).toHaveBeenCalledOnce()
    expect(api.runAutomationNow).toHaveBeenCalledWith(expect.objectContaining({ automationId: 'a', target: '/fixture/a', kind: 'cron' }))
    expect(emit).not.toHaveBeenCalledWith('remove-project', 'a')
  })

  it('keeps daily schedule validation and the original save payload', async () => {
    const { controller, notify } = setup()
    controller.openAutomationDialog('t')
    controller.automationScheduleDraft.value.dailyTimes = ['invalid']
    await controller.submitAutomationDialog()
    expect(api.upsertThreadAutomation).not.toHaveBeenCalled()
    controller.automationScheduleDraft.value.dailyTimes = ['09:00', '17:30']
    controller.automationDraft.value.prompt = 'fixture prompt'
    await controller.submitAutomationDialog()
    expect(api.upsertThreadAutomation).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't', status: 'ACTIVE', accountStorageId: null, model: null, timezone: expect.any(String), rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0\nRRULE:FREQ=DAILY;BYHOUR=17;BYMINUTE=30' }))
    expect(notify).toHaveBeenLastCalledWith('自动化已保存', 'success')
  })

  it('aborts obsolete account reads and blocks a save in the same tick as account selection', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal('fetch', fetcher)
    const { controller } = setup()
    controller.openAutomationDialog('t')
    controller.automationDraft.value.accountStorageId = 'a'
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal
    controller.automationDraft.value.accountStorageId = 'b'
    expect(signal.aborted).toBe(true)
    await controller.submitAutomationDialog()
    expect(api.upsertThreadAutomation).not.toHaveBeenCalled()
    first.resolve(new Response(JSON.stringify({ data: [{ id: 'old' }] })))
    second.resolve(new Response(JSON.stringify({ data: [{ id: 'new' }] })))
    await flush()
    expect(controller.accountModels.value.map(row => row.id)).toEqual(['new'])
    controller.closeAutomationDialog()
    expect(controller.accountModels.value).toEqual([])
  })

  it('does not refresh or publish after project deletion resolves after stop', async () => {
    const waiting = deferred<void>()
    api.deleteProjectAutomation.mockReturnValueOnce(waiting.promise)
    const { controller, emit, notify, stop } = setup()
    controller.setAutomationMaps({ thread: {}, project: { '/fixture/a': [automation('a')] } })
    controller.removeProjectAndAutomations('a')
    emit.mockClear()
    stop()
    waiting.resolve()
    await flush()
    expect(api.getProjectAutomationMap).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not refetch models when saving or replacing a draft for the same account', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] })))
    vi.stubGlobal('fetch', fetcher)
    const { controller } = setup()
    controller.openAutomationDialog('t')
    controller.automationDraft.value.accountStorageId = 'a'
    await flush()
    api.upsertThreadAutomation.mockResolvedValueOnce({ ...automation('saved', 'heartbeat'), accountStorageId: 'a', model: 'm' })
    controller.automationDraft.value.model = 'm'
    await controller.submitAutomationDialog()
    controller.onAutomationStatusChange('PAUSED')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(controller.accountModels.value.map(row => row.id)).toEqual(['m'])
    controller.closeAutomationDialog()
    controller.openAutomationDialog('t')
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
