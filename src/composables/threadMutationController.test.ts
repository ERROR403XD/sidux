import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiMessage, UiThread } from '../types/codex'
import { createThreadMutationController } from './threadMutationController'

const api = vi.hoisted(() => ({
  archiveThread: vi.fn(), renameThread: vi.fn(), forkThread: vi.fn(), forkThreadAtTurn: vi.fn(),
  revertThreadFileChanges: vi.fn(), rollbackThread: vi.fn(), interruptThreadTurn: vi.fn(), getThreadDetail: vi.fn(),
}))
vi.mock('../api/threadCommandGateway', () => api)
vi.mock('../api/threadReadGateway', () => ({ rollbackThread: api.rollbackThread, getThreadDetail: api.getThreadDetail }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  let revision = 0
  let selected = 'source'
  let cwd = '/project'
  let inProgress = true
  let interruptBlocked = false
  let activeTurnId: string | undefined = 'known-turn'
  const threads: UiThread[] = ['source', 'other'].map(id => ({
    id, title: 'Original', cwd: '/project', projectName: 'project', preview: '', hasWorktree: false,
    createdAtIso: '', updatedAtIso: '', unread: false, inProgress: false,
  }))
  const messages: UiMessage[] = [{ id: 'message', role: 'user', text: 'Original', turnId: 'turn', turnIndex: 1 }]
  const calls: string[] = []
  const list = {
    getVisibleThreads: () => threads,
    getSourceThreads: () => threads,
    removeArchivedThread: vi.fn(() => { calls.push('remove') }),
    load: vi.fn(async () => { calls.push('list') }),
  }
  const history = {
    getMessages: () => messages,
    markResumed: vi.fn(() => { calls.push('resumed') }),
    ensureLoaded: vi.fn(async () => { calls.push('ensure') }),
    load: vi.fn(async () => { calls.push('history') }),
    invalidateForRollback: vi.fn(() => { calls.push('invalidate') }),
    setMessages: vi.fn(() => { calls.push('messages') }),
    markDirty: vi.fn(() => { calls.push('history-dirty') }),
  }
  const status = {
    isInProgress: () => inProgress,
    isInterruptBlocked: () => interruptBlocked,
    setInProgress: vi.fn((_threadId: string, value: boolean) => { inProgress = value; calls.push('in-progress') }),
  }
  const activeTurn = {
    getTurnId: () => activeTurnId,
    setTurnId: vi.fn((_threadId: string, value: string) => { activeTurnId = value; calls.push('active-turn') }),
    clear: vi.fn(() => { activeTurnId = undefined; calls.push('clear-active') }),
  }
  const turnOrder = {
    maxTurnIndex: vi.fn(() => 3),
    replaceLookup: vi.fn(() => { calls.push('turn-order') }),
  }
  const live = {
    setAgentMessages: vi.fn(() => { calls.push('agent') }),
    clearReasoning: vi.fn(() => { calls.push('reasoning') }),
    clearCommands: vi.fn(() => { calls.push('commands') }),
  }
  const turns = {
    clearSummary: vi.fn(() => { calls.push('summary') }),
    clearActivity: vi.fn(() => { calls.push('activity') }),
    clearError: vi.fn(() => { calls.push('turn-error') }),
    setError: vi.fn(() => { calls.push('set-error') }),
  }
  const synchronization = {
    markThreadsDirty: vi.fn(() => { calls.push('dirty') }),
    sync: vi.fn(async () => { calls.push('sync') }),
  }
  const model = { readId: vi.fn(() => 'model'), setId: vi.fn(() => { calls.push('model') }) }
  const titles = { set: vi.fn(() => { calls.push('title') }), persist: vi.fn(async () => { calls.push('persist') }) }
  const onTitlesChanged = vi.fn(() => { calls.push('flags') })
  const markSearchChanged = vi.fn(() => { calls.push('search') })
  const insertOptimisticThread = vi.fn(() => { calls.push('insert') })
  const setPageError = vi.fn()
  const controller = createThreadMutationController({
    getAccountRevision: () => revision,
    selection: { getThreadId: () => selected, getCwd: () => cwd, setThreadId: value => { selected = value; calls.push('select') } },
    list, history, status, activeTurn, turnOrder, live, turns, synchronization, model, titles, onTitlesChanged, markSearchChanged, insertOptimisticThread, setPageError,
  })
  return { controller, calls, list, history, status, activeTurn, turnOrder, live, turns, synchronization, model, titles, onTitlesChanged, markSearchChanged, insertOptimisticThread, setPageError,
    getSelected: () => selected, select: (value: string) => { selected = value }, setCwd: (value: string) => { cwd = value },
    setRunning: (value: boolean) => { inProgress = value }, blockInterrupt: () => { interruptBlocked = true },
    setActiveTurn: (value: string | undefined) => { activeTurnId = value },
    switchAccount: () => { revision++; controller.invalidateForAccountChange() },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  api.archiveThread.mockResolvedValue(undefined)
  api.renameThread.mockResolvedValue(undefined)
  api.forkThread.mockResolvedValue({ threadId: 'forked', model: 'returned-model' })
  api.forkThreadAtTurn.mockResolvedValue({ threadId: 'forked', model: 'returned-model' })
  api.revertThreadFileChanges.mockResolvedValue({ errors: [] })
  api.rollbackThread.mockResolvedValue([])
  api.interruptThreadTurn.mockResolvedValue(undefined)
  api.getThreadDetail.mockResolvedValue({ activeTurnId: 'detail-turn' })
})

describe('complete rollback owner and private request slot', () => {
  it('finishes file undo before history rollback, invalidation, state commits and synchronization', async () => {
    const test = setup()
    const files = deferred<{ errors: string[] }>()
    const nextMessages: UiMessage[] = [{ id: 'remaining', role: 'user', text: 'Earlier', turnId: 'earlier', turnIndex: 0 }]
    api.revertThreadFileChanges.mockReturnValueOnce(files.promise)
    api.rollbackThread.mockImplementationOnce(async () => { test.calls.push('rollback'); return nextMessages })
    const operation = test.controller.rollbackSelectedThread('turn')
    expect(test.controller.isRollingBack.value).toBe(true)
    expect(api.revertThreadFileChanges).toHaveBeenCalledExactlyOnceWith('source', 'turn', '/project')
    expect(api.rollbackThread).not.toHaveBeenCalled()
    files.resolve({ errors: [] })
    expect(await operation).toBe(true)
    expect(api.rollbackThread).toHaveBeenCalledExactlyOnceWith('source', 3)
    expect(test.history.setMessages).toHaveBeenCalledExactlyOnceWith('source', nextMessages)
    expect(test.turnOrder.replaceLookup).toHaveBeenCalledExactlyOnceWith('source', {})
    expect(test.calls).toEqual(['rollback', 'turn-order', 'invalidate', 'messages', 'agent', 'reasoning', 'commands', 'summary', 'activity', 'turn-error', 'dirty', 'sync'])
    expect(test.controller.isRollingBack.value).toBe(false)
  })

  it('rolls back history without a file request when no selected directory exists', async () => {
    const test = setup()
    test.setCwd(' ')
    expect(await test.controller.rollbackSelectedThread('turn')).toBe(true)
    expect(api.revertThreadFileChanges).not.toHaveBeenCalled()
    expect(api.rollbackThread).toHaveBeenCalledExactlyOnceWith('source', 3)
    expect(test.synchronization.sync).toHaveBeenCalledOnce()
  })

  it('deduplicates a current rollback and blocks history writes when file undo reports errors', async () => {
    const test = setup()
    const files = deferred<{ errors: string[] }>()
    api.revertThreadFileChanges.mockReturnValueOnce(files.promise)
    const operation = test.controller.rollbackSelectedThread('turn')
    expect(await test.controller.rollbackSelectedThread('turn')).toBe(false)
    expect(api.revertThreadFileChanges).toHaveBeenCalledOnce()
    files.resolve({ errors: ['Undo rejected', 'File conflict'] })
    expect(await operation).toBe(false)
    expect(api.rollbackThread).not.toHaveBeenCalled()
    expect(test.calls).toEqual([])
    expect(test.setPageError).toHaveBeenLastCalledWith('Undo rejected\nFile conflict')
    expect(test.controller.isRollingBack.value).toBe(false)
  })

  it.each(['stop', 'account'])('releases a %s rollback slot without letting its old finally release a new slot', async transition => {
    const test = setup()
    const previousFiles = deferred<{ errors: string[] }>()
    const nextFiles = deferred<{ errors: string[] }>()
    api.revertThreadFileChanges.mockReturnValueOnce(previousFiles.promise).mockReturnValueOnce(nextFiles.promise)
    const previous = test.controller.rollbackSelectedThread('turn')
    if (transition === 'stop') {
      test.controller.stop()
      expect(test.controller.isRollingBack.value).toBe(false)
      expect(await test.controller.rollbackSelectedThread('turn')).toBe(false)
      test.controller.start()
    } else {
      test.switchAccount()
      expect(test.controller.isRollingBack.value).toBe(false)
    }
    const next = test.controller.rollbackSelectedThread('turn')
    previousFiles.resolve({ errors: [] })
    expect(await previous).toBe(false)
    expect(test.controller.isRollingBack.value).toBe(true)
    expect(api.rollbackThread).not.toHaveBeenCalled()
    expect(api.revertThreadFileChanges).toHaveBeenCalledTimes(2)
    nextFiles.resolve({ errors: [] })
    expect(await next).toBe(true)
    expect(api.rollbackThread).toHaveBeenCalledOnce()
    expect(test.controller.isRollingBack.value).toBe(false)
  })

  it.each(['stop', 'account'])('rejects late rollback history after %s before touching history live or turn state', async transition => {
    const test = setup()
    const history = deferred<UiMessage[]>()
    api.rollbackThread.mockReturnValueOnce(history.promise)
    const operation = test.controller.rollbackSelectedThread('turn')
    await Promise.resolve()
    expect(api.rollbackThread).toHaveBeenCalledOnce()
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    history.resolve([{ id: 'old', role: 'assistant', text: 'Old result' }])
    expect(await operation).toBe(false)
    expect(test.calls).toEqual([])
    expect(test.setPageError.mock.calls).toEqual([['']])
    expect(test.synchronization.sync).not.toHaveBeenCalled()
  })

  it.each(['stop', 'account'])('does not publish stale file errors after %s', async transition => {
    const test = setup()
    const files = deferred<{ errors: string[] }>()
    api.revertThreadFileChanges.mockReturnValueOnce(files.promise)
    const operation = test.controller.rollbackSelectedThread('turn')
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    files.reject(new Error('Old file failure'))
    expect(await operation).toBe(false)
    expect(test.setPageError.mock.calls).toEqual([['']])
    expect(api.rollbackThread).not.toHaveBeenCalled()
  })

  it.each(['stop', 'account'])('checks context again after rollback synchronization crosses %s', async transition => {
    const test = setup()
    const sync = deferred<void>()
    test.synchronization.sync.mockReturnValueOnce(sync.promise)
    const operation = test.controller.rollbackSelectedThread('turn')
    await Promise.resolve()
    await Promise.resolve()
    expect(test.synchronization.sync).toHaveBeenCalledOnce()
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    sync.resolve()
    expect(await operation).toBe(false)
    expect(test.setPageError.mock.calls).toEqual([['']])
    expect(test.controller.isRollingBack.value).toBe(false)
  })

  it('keeps rollback bound to the captured thread when selection changes on the same account', async () => {
    const test = setup()
    const files = deferred<{ errors: string[] }>()
    api.revertThreadFileChanges.mockReturnValueOnce(files.promise)
    const operation = test.controller.rollbackSelectedThread('turn')
    test.select('other')
    files.resolve({ errors: [] })
    expect(await operation).toBe(true)
    expect(api.rollbackThread).toHaveBeenCalledExactlyOnceWith('source', 3)
    expect(test.history.setMessages).toHaveBeenCalledExactlyOnceWith('source', [])
    expect(test.getSelected()).toBe('other')
  })

  it('does not start rollback for a blank or unavailable turn', async () => {
    const test = setup()
    expect(await test.controller.rollbackSelectedThread(' ')).toBe(false)
    expect(await test.controller.rollbackSelectedThread('missing')).toBe(false)
    expect(test.controller.isRollingBack.value).toBe(false)
    expect(api.revertThreadFileChanges).not.toHaveBeenCalled()
    expect(api.rollbackThread).not.toHaveBeenCalled()
  })
})

describe('complete interrupt owner and private request slot', () => {
  it('uses a known turn without a detail read and keeps busy until synchronization finishes', async () => {
    const test = setup()
    const sync = deferred<void>()
    test.synchronization.sync.mockImplementationOnce(() => { test.calls.push('sync'); return sync.promise })
    const operation = test.controller.interruptSelectedThreadTurn()
    expect(api.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith('source', 'known-turn')
    await Promise.resolve()
    expect(test.controller.isInterruptingTurn.value).toBe(true)
    expect(api.getThreadDetail).not.toHaveBeenCalled()
    expect(test.calls).toEqual(['in-progress', 'activity', 'turn-error', 'clear-active', 'history-dirty', 'dirty', 'sync'])
    expect(test.status.setInProgress).toHaveBeenCalledExactlyOnceWith('source', false)
    sync.resolve()
    await operation
    expect(test.controller.isInterruptingTurn.value).toBe(false)
  })

  it('locks admission before recovering a missing turn and sends exactly one interrupt', async () => {
    const test = setup()
    const detail = deferred<{ activeTurnId: string }>()
    test.setActiveTurn(undefined)
    api.getThreadDetail.mockReturnValueOnce(detail.promise)
    const operation = test.controller.interruptSelectedThreadTurn()
    expect(test.controller.isInterruptingTurn.value).toBe(true)
    await test.controller.interruptSelectedThreadTurn()
    expect(api.getThreadDetail).toHaveBeenCalledExactlyOnceWith('source')
    expect(api.interruptThreadTurn).not.toHaveBeenCalled()
    detail.resolve({ activeTurnId: 'recovered-turn' })
    await operation
    expect(test.activeTurn.setTurnId).toHaveBeenCalledExactlyOnceWith('source', 'recovered-turn')
    expect(api.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith('source', 'recovered-turn')
    expect(test.controller.isInterruptingTurn.value).toBe(false)
  })

  it('reports a missing recovered turn as a current error and releases admission for retry', async () => {
    const test = setup()
    test.setActiveTurn(undefined)
    api.getThreadDetail.mockResolvedValueOnce({ activeTurnId: '' })
    await test.controller.interruptSelectedThreadTurn()
    expect(api.interruptThreadTurn).not.toHaveBeenCalled()
    expect(test.turns.setError).toHaveBeenCalledExactlyOnceWith('source', 'Could not determine active turn id for interrupt')
    expect(test.setPageError).toHaveBeenLastCalledWith('Could not determine active turn id for interrupt')
    expect(test.controller.isInterruptingTurn.value).toBe(false)
    await test.controller.interruptSelectedThreadTurn()
    expect(api.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(api.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith('source', 'detail-turn')
  })

  it.each(['stop', 'account'])('does not set the recovered turn or send an interrupt after a detail read crosses %s', async transition => {
    const test = setup()
    const detail = deferred<{ activeTurnId: string }>()
    test.setActiveTurn(undefined)
    api.getThreadDetail.mockReturnValueOnce(detail.promise)
    const operation = test.controller.interruptSelectedThreadTurn()
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    detail.resolve({ activeTurnId: 'old-turn' })
    await operation
    expect(test.activeTurn.setTurnId).not.toHaveBeenCalled()
    expect(api.interruptThreadTurn).not.toHaveBeenCalled()
    expect(test.calls).toEqual([])
    expect(test.setPageError.mock.calls).toEqual([['']])
  })

  it.each(['stop', 'account'])('does not let an old interrupt finally release a new %s request', async transition => {
    const test = setup()
    const previousRequest = deferred<void>()
    const nextRequest = deferred<void>()
    api.interruptThreadTurn.mockReturnValueOnce(previousRequest.promise).mockReturnValueOnce(nextRequest.promise)
    const previous = test.controller.interruptSelectedThreadTurn()
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    expect(test.controller.isInterruptingTurn.value).toBe(false)
    test.setActiveTurn('new-turn')
    const next = test.controller.interruptSelectedThreadTurn()
    previousRequest.resolve()
    await previous
    expect(test.controller.isInterruptingTurn.value).toBe(true)
    expect(test.calls).toEqual([])
    expect(api.interruptThreadTurn.mock.calls).toEqual([['source', 'known-turn'], ['source', 'new-turn']])
    nextRequest.resolve()
    await next
    expect(test.controller.isInterruptingTurn.value).toBe(false)
    expect(test.synchronization.sync).toHaveBeenCalledOnce()
  })

  it('keeps a missing-turn interrupt bound to the original thread after selection changes', async () => {
    const test = setup()
    const detail = deferred<{ activeTurnId: string }>()
    test.setActiveTurn(undefined)
    api.getThreadDetail.mockReturnValueOnce(detail.promise)
    const operation = test.controller.interruptSelectedThreadTurn()
    test.select('other')
    detail.resolve({ activeTurnId: 'original-turn' })
    await operation
    expect(api.interruptThreadTurn).toHaveBeenCalledExactlyOnceWith('source', 'original-turn')
    expect(test.calls).toEqual(['active-turn'])
    expect(test.synchronization.sync).not.toHaveBeenCalled()
    expect(test.getSelected()).toBe('other')
    expect(test.setPageError.mock.calls).toEqual([['']])
  })

  it.each(['stop', 'account'])('does not publish an old interrupt error after %s', async transition => {
    const test = setup()
    const request = deferred<void>()
    api.interruptThreadTurn.mockReturnValueOnce(request.promise)
    const operation = test.controller.interruptSelectedThreadTurn()
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    request.reject(new Error('Old interrupt failed'))
    await operation
    expect(test.calls).toEqual([])
    expect(test.setPageError.mock.calls).toEqual([['']])
    expect(test.turns.setError).not.toHaveBeenCalled()
  })

  it('publishes a current interrupt error without clearing running state', async () => {
    const test = setup()
    api.interruptThreadTurn.mockRejectedValueOnce(new Error('Current failure'))
    await test.controller.interruptSelectedThreadTurn()
    expect(test.turns.setError).toHaveBeenCalledExactlyOnceWith('source', 'Current failure')
    expect(test.setPageError).toHaveBeenLastCalledWith('Current failure')
    expect(test.status.setInProgress).not.toHaveBeenCalled()
    expect(test.activeTurn.clear).not.toHaveBeenCalled()
    expect(test.synchronization.sync).not.toHaveBeenCalled()
    expect(test.controller.isInterruptingTurn.value).toBe(false)
  })

  it.each(['stop', 'account'])('ignores an old synchronization failure after interrupt commits and crosses %s', async transition => {
    const test = setup()
    const sync = deferred<void>()
    test.synchronization.sync.mockReturnValueOnce(sync.promise)
    const operation = test.controller.interruptSelectedThreadTurn()
    await Promise.resolve()
    expect(test.synchronization.sync).toHaveBeenCalledOnce()
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    sync.reject(new Error('Old sync failed'))
    await operation
    expect(test.turns.setError).not.toHaveBeenCalled()
    expect(test.setPageError.mock.calls).toEqual([['']])
    expect(test.controller.isInterruptingTurn.value).toBe(false)
  })

  it.each(['stopped', 'idle', 'blocked', 'no-selection'])('blocks interrupt admission for %s without starting reads or writes', async condition => {
    const test = setup()
    if (condition === 'stopped') test.controller.stop()
    if (condition === 'idle') test.setRunning(false)
    if (condition === 'blocked') test.blockInterrupt()
    if (condition === 'no-selection') test.select('')
    await test.controller.interruptSelectedThreadTurn()
    expect(api.getThreadDetail).not.toHaveBeenCalled()
    expect(api.interruptThreadTurn).not.toHaveBeenCalled()
    expect(test.calls).toEqual([])
    expect(test.setPageError).not.toHaveBeenCalled()
    expect(test.controller.isInterruptingTurn.value).toBe(false)
  })
})

describe('complete archive rename and fork owner', () => {
  it('keeps a background rename bound to its original target and commit order', async () => {
    const test = setup()
    const rename = deferred<void>()
    api.renameThread.mockReturnValueOnce(rename.promise)
    const operation = test.controller.renameThreadById('source', '  Confirmed  ')
    test.select('other')
    rename.resolve()
    await operation
    expect(api.renameThread).toHaveBeenCalledExactlyOnceWith('source', 'Confirmed')
    expect(test.titles.set).toHaveBeenCalledExactlyOnceWith('source', 'Confirmed')
    expect(test.calls).toEqual(['title', 'flags', 'persist', 'search'])
    expect(test.getSelected()).toBe('other')
  })

  it.each(['stop', 'account'])('does not persist or commit an old rename after %s', async transition => {
    const test = setup()
    const rename = deferred<void>()
    api.renameThread.mockReturnValueOnce(rename.promise)
    const operation = test.controller.renameThreadById('source', 'Old')
    if (transition === 'stop') { test.controller.stop(); test.controller.start() }
    else test.switchAccount()
    rename.resolve()
    await operation
    expect(test.calls).toEqual([])
    expect(test.setPageError).not.toHaveBeenCalled()
  })

  it('preserves adjacent selection and the original archive refresh order', async () => {
    const test = setup()
    const archive = deferred<void>()
    api.archiveThread.mockReturnValueOnce(archive.promise)
    const operation = test.controller.archiveThreadById('source')
    expect(test.getSelected()).toBe('other')
    expect(test.history.load).toHaveBeenCalledExactlyOnceWith('other', { silent: true })
    archive.resolve()
    await operation
    expect(test.calls).toEqual(['select', 'history', 'search', 'remove', 'list', 'ensure'])
    expect(test.list.removeArchivedThread).toHaveBeenCalledExactlyOnceWith('source')
  })

  it('does not start archive history recovery after the list read changes account', async () => {
    const test = setup()
    const list = deferred<void>()
    test.list.load.mockReturnValueOnce(list.promise)
    const operation = test.controller.archiveThreadById('source')
    await Promise.resolve()
    expect(test.list.load).toHaveBeenCalledOnce()
    test.switchAccount()
    list.resolve()
    await operation
    expect(test.history.ensureLoaded).not.toHaveBeenCalled()
  })

  it('owns full fork model, resumed history and selection sequencing', async () => {
    const test = setup()
    expect(await test.controller.forkThreadById('source')).toBe('forked')
    expect(api.forkThread).toHaveBeenCalledExactlyOnceWith('source', '/project', 'model')
    expect(test.calls).toEqual(['insert', 'model', 'resumed', 'select', 'list', 'history'])
    expect(test.model.setId).toHaveBeenCalledExactlyOnceWith('forked', 'returned-model')
    expect(test.getSelected()).toBe('forked')
  })

  it('keeps an exact history fork title and defers selection until persistence completes', async () => {
    const test = setup()
    const persist = deferred<void>()
    test.titles.persist.mockReturnValueOnce(persist.promise)
    const operation = test.controller.forkThreadFromTurn('source', 'turn')
    await Promise.resolve()
    await Promise.resolve()
    expect(test.titles.set).toHaveBeenCalledExactlyOnceWith('forked', 'Fork: Original')
    expect(test.getSelected()).toBe('source')
    persist.resolve()
    expect(await operation).toBe('forked')
    expect(test.calls).toEqual(['insert', 'model', 'title', 'flags', 'search', 'select', 'history', 'list'])
    expect(api.forkThreadAtTurn).toHaveBeenCalledExactlyOnceWith('source', 'turn')
  })

  it('rejects a superseded fork history completion without changing the current error', async () => {
    const test = setup()
    const history = deferred<void>()
    test.history.load.mockReturnValueOnce(history.promise)
    const operation = test.controller.forkThreadById('source')
    await Promise.resolve()
    await Promise.resolve()
    expect(test.history.load).toHaveBeenCalledOnce()
    test.select('other')
    history.reject(new Error('Old failure'))
    expect(await operation).toBe('')
    expect(test.setPageError.mock.calls).toEqual([['']])
    expect(test.getSelected()).toBe('other')
  })

  it('rejects blank IDs and unavailable source turns without starting mutations', async () => {
    const test = setup()
    await test.controller.renameThreadById('source', ' ')
    expect(await test.controller.forkThreadById(' ')).toBe('')
    expect(await test.controller.forkThreadFromTurn('source', 'missing')).toBe('')
    expect(api.renameThread).not.toHaveBeenCalled()
    expect(api.forkThread).not.toHaveBeenCalled()
    expect(api.forkThreadAtTurn).not.toHaveBeenCalled()
    expect(test.calls).toEqual([])
  })

  it('invalidates retained context callbacks and blocks writes across ten stop/start cycles', async () => {
    const test = setup()
    for (let cycle = 0; cycle < 10; cycle++) {
      const isCurrent = test.controller.captureThreadActionContext()
      test.controller.stop()
      expect(isCurrent()).toBe(false)
      await test.controller.renameThreadById('source', 'Old')
      await test.controller.archiveThreadById('source')
      expect(await test.controller.forkThreadById('source')).toBe('')
      expect(await test.controller.forkThreadFromTurn('source', 'turn')).toBe('')
      test.controller.start()
      expect(isCurrent()).toBe(false)
      expect(test.controller.captureThreadActionContext()()).toBe(true)
    }
    expect(api.renameThread).not.toHaveBeenCalled()
    expect(api.archiveThread).not.toHaveBeenCalled()
    expect(api.forkThread).not.toHaveBeenCalled()
    expect(api.forkThreadAtTurn).not.toHaveBeenCalled()
  })
})
