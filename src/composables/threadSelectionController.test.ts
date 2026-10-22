import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApiError } from '../api/codexErrors'
import type { UiThread } from '../types/codex'
import { createThreadSelectionController } from './threadSelectionController'

const idKey = 'codex-web-local.selected-thread-id.v1'
const modeKey = 'codex-web-local.collaboration-mode-by-context.v1'
const legacyKey = 'codex-web-local.collaboration-mode.v1'
function deferred() {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function setup(initial: Record<string, string> = {}) {
  const storage = new Map(Object.entries(initial))
  const localStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value) }),
    removeItem: vi.fn((key: string) => { storage.delete(key) }),
  }
  vi.stubGlobal('window', { localStorage })
  let account = 0
  const listed = ref<UiThread[]>([])
  const snapshots = ref<Record<string, UiThread>>({})
  const projects = ref<Array<{ id: string; cwds: string[] }>>([])
  const titles = ref<Record<string, string>>({})
  const history = { load: vi.fn().mockResolvedValue(undefined) }
  const model = { projectSelectedThread: vi.fn(), refreshModelPreferences: vi.fn().mockResolvedValue(undefined) }
  const metadata = { getTitle: (id: string) => titles.value[id] ?? '', refreshSkills: vi.fn().mockResolvedValue(undefined) }
  const errors = { setPage: vi.fn(), setTurn: vi.fn() }
  const resetReasoningItem = vi.fn()
  const onChanged = vi.fn()
  const controller = createThreadSelectionController({
    getAccountRevision: () => account,
    getListedThreads: () => listed.value,
    getSnapshot: id => snapshots.value[id],
    getVirtualProjects: () => projects.value,
    history, model, metadata, errors, resetReasoningItem, onChanged,
  })
  return {
    controller, history, model, metadata, errors, resetReasoningItem, onChanged,
    storage, localStorage, listed, snapshots, projects, titles,
    changeAccount: () => { account++ },
  }
}
function thread(id: string, title = id): UiThread {
  return { id, title, cwd: '/workspace', projectName: 'workspace', hasWorktree: false, createdAtIso: '', updatedAtIso: '', preview: '', unread: false, inProgress: false }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('selection operation ownership', () => {
  it.each(['history', 'model'].flatMap(phase => ['restart', 'account', 'selection', 'round-trip'].flatMap(transition => ['success', 'failure'].map(outcome => ({ phase, transition, outcome })))))
    ('isolates late $phase $outcome after $transition', async ({ phase, transition, outcome }) => {
      const test = setup()
      const old = deferred()
      if (phase === 'history') test.history.load.mockReturnValueOnce(old.promise)
      else test.model.refreshModelPreferences.mockReturnValueOnce(old.promise)
      const selection = test.controller.selectThread('a')
      await flush()
      expect(phase === 'history' ? test.history.load : test.model.refreshModelPreferences).toHaveBeenCalledOnce()
      if (transition === 'restart') {
        test.controller.stop()
        test.controller.start()
      } else if (transition === 'account') test.changeAccount()
      else {
        test.controller.primeSelectedThread('b')
        if (transition === 'round-trip') test.controller.primeSelectedThread('a')
      }
      const reads = test.model.refreshModelPreferences.mock.calls.length
      if (outcome === 'failure') old.reject(new Error('thread not found'))
      else old.resolve()
      expect(await selection).toBe('error')
      expect(test.model.refreshModelPreferences).toHaveBeenCalledTimes(reads)
      expect(test.metadata.refreshSkills).not.toHaveBeenCalled()
      expect(test.errors.setPage).not.toHaveBeenCalled()
      expect(test.errors.setTurn).not.toHaveBeenCalled()
    })

  it('finishes history before model recovery and starts skills only for the current selection', async () => {
    const test = setup()
    const history = deferred()
    test.history.load.mockReturnValueOnce(history.promise)
    const selection = test.controller.selectThread('a')
    expect(test.history.load).toHaveBeenCalledExactlyOnceWith('a', { retry: true })
    expect(test.model.refreshModelPreferences).not.toHaveBeenCalled()
    history.resolve()
    expect(await selection).toBe('ok')
    expect(test.model.refreshModelPreferences).toHaveBeenCalledExactlyOnceWith({ includeProviderModels: true })
    expect(test.metadata.refreshSkills).toHaveBeenCalledOnce()
  })

  it('gives a newer same-thread selection ownership without blocking on the older completion', async () => {
    const test = setup()
    const old = deferred()
    test.history.load.mockReturnValueOnce(old.promise)
    const selection = test.controller.selectThread('a')
    expect(await test.controller.selectThread('a')).toBe('ok')
    old.resolve()
    expect(await selection).toBe('error')
    expect(test.model.refreshModelPreferences).toHaveBeenCalledOnce()
    expect(test.metadata.refreshSkills).toHaveBeenCalledOnce()
    expect(test.model.projectSelectedThread).toHaveBeenCalledOnce()
  })

  it('rejects stopped commands, permits synchronous priming and restarts immediately', async () => {
    const test = setup()
    test.controller.stop()
    expect(await test.controller.selectThread('ignored')).toBe('error')
    expect(test.controller.selectedThreadId.value).toBe('')
    expect(test.history.load).not.toHaveBeenCalled()
    test.controller.primeSelectedThread('primed', { persist: false })
    expect(test.controller.selectedThreadId.value).toBe('primed')
    expect(test.storage.has(idKey)).toBe(false)
    test.controller.start()
    expect(await test.controller.selectThread('current')).toBe('ok')
    expect(test.history.load).toHaveBeenCalledOnce()
  })

  it.each([
    { cause: new CodexApiError('missing', { code: 'http_error', status: 404 }), result: 'not-found', message: 'missing' },
    { cause: new Error('conversation not found'), result: 'not-found', message: 'conversation not found' },
    { cause: new Error('offline'), result: 'error', message: 'offline' },
    { cause: 'unknown failure', result: 'error', message: 'Unknown application error' },
  ])('preserves current error classification: $message', async ({ cause, result, message }) => {
    const test = setup()
    test.history.load.mockRejectedValueOnce(cause)
    expect(await test.controller.selectThread('a')).toBe(result)
    expect(test.errors.setPage).toHaveBeenCalledExactlyOnceWith(message)
    expect(test.errors.setTurn).toHaveBeenCalledExactlyOnceWith('a', message, { transient: true })
    expect(test.model.refreshModelPreferences).not.toHaveBeenCalled()
  })

  it('handles synchronous model failures without starting skills and permits retry', async () => {
    const test = setup()
    test.model.refreshModelPreferences.mockImplementationOnce(() => { throw new Error('offline') })
    expect(await test.controller.selectThread('a')).toBe('error')
    expect(test.metadata.refreshSkills).not.toHaveBeenCalled()
    expect(await test.controller.selectThread('a')).toBe('ok')
  })

  it('isolates ten late selections across stop and restart', async () => {
    const test = setup()
    const old = Array.from({ length: 10 }, deferred)
    const pending: Array<Promise<string>> = []
    for (const [index, request] of old.entries()) {
      test.history.load.mockReturnValueOnce(request.promise)
      pending.push(test.controller.selectThread(String(index)))
      test.controller.stop()
      test.controller.start()
    }
    expect(await test.controller.selectThread('current')).toBe('ok')
    old.reverse().forEach(request => request.resolve())
    expect(await Promise.all(pending)).toEqual(Array(10).fill('error'))
    expect(test.model.refreshModelPreferences).toHaveBeenCalledOnce()
    expect(test.metadata.refreshSkills).toHaveBeenCalledOnce()
    expect(test.controller.selectedThreadId.value).toBe('current')
  })
})

describe('selection projection and per-conversation preferences', () => {
  it('loads selection, preserves nonpersisting priming and does nothing on the same ID', () => {
    const test = setup({ [idKey]: 'saved' })
    expect(test.controller.selectedThreadId.value).toBe('saved')
    test.controller.primeSelectedThread('primed', { persist: false })
    expect(test.storage.get(idKey)).toBe('saved')
    test.controller.setSelectedThreadId('primed')
    expect(test.model.projectSelectedThread).toHaveBeenCalledOnce()
    expect(test.resetReasoningItem).toHaveBeenCalledOnce()
    expect(test.onChanged).toHaveBeenCalledOnce()
    expect(test.localStorage.setItem).not.toHaveBeenCalled()
    test.controller.setSelectedThreadId('current')
    expect(test.storage.get(idKey)).toBe('current')
    test.controller.setSelectedThreadId('')
    expect(test.storage.has(idKey)).toBe(false)
  })

  it('projects listed data, snapshot task, organization and cached title reactively', () => {
    const test = setup({ [idKey]: 'a' })
    expect(test.controller.selectedThread.value).toBeNull()
    test.snapshots.value.a = thread('a', 'snapshot')
    test.snapshots.value.a.task = { id: 'task', title: 'task', parentThreadId: '', nickname: '', role: '', path: '', status: 'running', canAcceptDirectInput: null, preview: '' }
    expect(test.controller.selectedThread.value?.title).toBe('snapshot')
    test.listed.value = [thread('a', 'listed')]
    test.projects.value = [{ id: 'virtual', cwds: ['/workspace'] }]
    test.titles.value.a = 'cached'
    expect(test.controller.selectedThread.value).toMatchObject({ title: 'cached', projectName: 'virtual', cwd: '/workspace' })
    expect(test.controller.selectedThread.value?.task).toBe(test.snapshots.value.a.task)
    test.titles.value = {}
    expect(test.controller.selectedThread.value?.title).toBe('listed')
    test.controller.primeSelectedThread('missing')
    expect(test.controller.selectedThread.value).toBeNull()
  })

  it('keeps thread modes across reload while new conversations stay default', () => {
    const test = setup()
    test.controller.setSelectedThreadId('a')
    test.controller.setSelectedCollaborationMode('plan')
    test.controller.setSelectedThreadId('b')
    expect(test.controller.selectedCollaborationMode.value).toBe('default')
    test.controller.setSelectedThreadId('a')
    expect(test.controller.selectedCollaborationMode.value).toBe('plan')
    const restored = setup(Object.fromEntries(test.storage))
    expect(restored.controller.selectedCollaborationMode.value).toBe('plan')
    restored.controller.setSelectedThreadId('')
    restored.controller.setSelectedCollaborationMode('plan')
    restored.controller.setSelectedThreadId('b')
    restored.controller.setSelectedThreadId('')
    expect(restored.controller.selectedCollaborationMode.value).toBe('default')
    expect(JSON.parse(restored.storage.get(modeKey)!)).toEqual({ a: 'plan' })
  })

  it.each(['{', '[]', 'null'])('recovers corrupt mode storage %s without inheriting the legacy global choice', raw => {
    const test = setup({ [modeKey]: raw, [legacyKey]: 'plan' })
    expect(test.controller.selectedCollaborationMode.value).toBe('default')
    test.controller.setSelectedThreadId('a')
    test.controller.setSelectedCollaborationMode('plan')
    expect(test.storage.has(legacyKey)).toBe(false)
    expect(JSON.parse(test.storage.get(modeKey)!)).toEqual({ a: 'plan' })
  })

  it('prunes saved modes through a command and safely handles arbitrary thread IDs', () => {
    const test = setup()
    test.controller.setSelectedCollaborationModeForThread('__proto__', 'plan')
    test.controller.setSelectedCollaborationModeForThread('a', 'plan')
    test.controller.setSelectedThreadId('a')
    test.controller.pruneCollaborationPreferences(new Set(['__proto__']))
    expect(test.controller.selectedCollaborationMode.value).toBe('default')
    expect(Object.keys(JSON.parse(test.storage.get(modeKey)!))).toEqual(['__proto__'])
    test.controller.setSelectedThreadId('__proto__')
    expect(test.controller.selectedCollaborationMode.value).toBe('plan')
    test.controller.setSelectedCollaborationMode('default')
    expect(test.storage.has(modeKey)).toBe(false)
  })

  it('keeps in-memory collaboration preferences when persistence fails', () => {
    const test = setup({ [idKey]: 'a' })
    test.localStorage.setItem.mockImplementation(() => { throw new Error('storage unavailable') })
    test.controller.setSelectedCollaborationMode('plan')
    expect(test.controller.selectedCollaborationMode.value).toBe('plan')
  })
})
