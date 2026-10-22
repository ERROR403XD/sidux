import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadReadDetail, ThreadTurnPage } from '../api/threadReadGateway'
import type { UiMessage } from '../types/codex'
import { createThreadHistoryController } from './threadHistoryController'
import { createThreadTurnOrderState } from './threadTurnOrderState'
import { createThreadActiveTurnState } from './threadActiveTurnState'
import { createThreadLiveAgentState } from './threadLiveAgentState'
import { createThreadLiveCommandState } from './threadLiveCommandState'
import { createThreadLiveFileChangeState } from './threadLiveFileChangeState'

const api = vi.hoisted(() => ({
  resumeThread: vi.fn(),
  getThreadDetail: vi.fn(),
  getOlderThreadMessages: vi.fn(),
  invalidateThreadResumeCache: vi.fn(),
}))
vi.mock('../api/threadReadGateway', () => api)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue
    reject = rejectValue
  })
  return { promise, resolve, reject }
}

function message(id: string, extra: Partial<UiMessage> = {}): UiMessage {
  return { id, turnId: id, role: 'assistant', text: id, ...extra }
}

function snapshot(id: string, extra: Partial<ThreadReadDetail> = {}): ThreadReadDetail {
  return {
    model: 'model', modelProvider: 'provider', messages: [message(id)], inProgress: false,
    activeTurnId: '', turnIndexByTurnId: { [id]: 0 }, hasMoreOlder: true,
    historyPosition: { source: 'native', nextCursor: 'opaque/+' }, ...extra,
  }
}

function page(id: string): ThreadTurnPage {
  return { ...snapshot(id), startTurnIndex: 0 }
}

function setup() {
  let accountRevision = 0
  let selectedThreadId = 'thread'
  const turnOrder = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId: ref({}) })
  const activeTurn = createThreadActiveTurnState({ turnIdByThreadId: ref({}) })
  const agent = createThreadLiveAgentState({ messagesByThreadId: ref({}) })
  const commands = createThreadLiveCommandState({ commandsByThreadId: ref({}) })
  const files = createThreadLiveFileChangeState({ messagesByThreadId: ref({}) })
  const progress = new Map<string, boolean>()
  const errors = new Map<string, string>()
  const metadata = { setProvider: vi.fn(), setModel: vi.fn() }
  const deliveries = { refresh: vi.fn(), refreshReceipts: vi.fn(async () => {}), observe: vi.fn() }
  const clearCompleted = vi.fn()
  const scheduleEventSync = vi.fn()
  const pageError = vi.fn()
  const controller = createThreadHistoryController({
    getAccountRevision: () => accountRevision,
    getSelectedThreadId: () => selectedThreadId,
    getThreadVersion: () => 'v1',
    reuseMs: 1500,
    metadata,
    status: {
      isInProgress: id => progress.get(id) === true,
      setInProgress: (id, value) => { progress.set(id, value) },
      hasTransientError: id => errors.has(id),
      setTransientError: (id, value) => { errors.set(id, value) },
      clearTransientError: id => { errors.delete(id) },
      setPageError: pageError,
    },
    turns: {
      getLookup: turnOrder.getLookup,
      replaceLookup: turnOrder.replace,
      markMessagesPersisted: vi.fn(),
      rebindLiveFileChanges: id => files.rebindTurnIndices(id, turnOrder.getLookup(id)),
      getActiveTurnId: activeTurn.getTurnId,
      setActiveTurnId: activeTurn.setTurnId,
      clearActiveTurn: activeTurn.clear,
    },
    live: {
      getAgentMessages: agent.getMessages,
      setAgentMessages: agent.set,
      clearAgentMessages: agent.clear,
      removePersistedCommands: commands.removePersistedIn,
      removePersistedFileChanges: files.removePersistedIn,
      clearCompleted,
    },
    deliveries,
    scheduleEventSync,
  })
  return {
    controller, turnOrder, activeTurn, agent, commands, files, progress, errors,
    metadata, deliveries, clearCompleted, scheduleEventSync, pageError,
    select: (id: string) => { selectedThreadId = id },
    switchAccount: () => {
      accountRevision++
      controller.invalidateForAccountChange([selectedThreadId])
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', {})
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('complete thread history owner', () => {
  it('coalesces concurrent loads, reuses a current snapshot and keeps independent threads separate', async () => {
    const test = setup()
    const pending = deferred<ThreadReadDetail>()
    api.getThreadDetail.mockReturnValueOnce(pending.promise).mockResolvedValue(snapshot('other'))
    const first = test.controller.loadMessages('thread')
    const joined = test.controller.loadMessages('thread')
    await test.controller.loadMessages('other')
    expect(api.getThreadDetail.mock.calls.map(call => call[0])).toEqual(['thread', 'other'])
    pending.resolve(snapshot('latest'))
    await Promise.all([first, joined])
    await test.controller.loadMessages('thread')
    expect(api.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(api.resumeThread).not.toHaveBeenCalled()
    expect(test.controller.isLoaded('thread')).toBe(true)
  })

  it('keeps realtime activity and messages newer than the pending history snapshot', async () => {
    const test = setup()
    const pending = deferred<ThreadReadDetail>()
    api.getThreadDetail.mockReturnValue(pending.promise)
    const load = test.controller.loadMessages('thread')
    test.controller.history.markDirty('thread')
    test.progress.set('thread', true)
    test.activeTurn.setTurnId('thread', 'new-turn')
    test.agent.set('thread', [message('new-turn', { messageType: 'agentMessage.live' })])
    pending.resolve(snapshot('old-turn'))
    await load
    expect(test.progress.get('thread')).toBe(true)
    expect(test.activeTurn.getTurnId('thread')).toBe('new-turn')
    expect(test.agent.getMessages('thread').map(row => row.id)).toEqual(['new-turn'])
    expect(test.clearCompleted).not.toHaveBeenCalled()
    expect(test.scheduleEventSync).toHaveBeenCalledTimes(1)
    api.getThreadDetail.mockResolvedValue(snapshot('new-turn', { turnIndexByTurnId: { 'old-turn': 0, 'new-turn': 1 } }))
    await test.controller.loadMessages('thread')
    expect(api.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(test.agent.getMessages('thread')).toEqual([])
  })

  it('preserves older pages, optimistic input and live command/file deduplication', async () => {
    const test = setup()
    const optimistic = message('optimistic-user:delivery', { role: 'user', text: 'pending', messageType: 'userMessage.optimistic' })
    test.controller.setPersistedMessagesForThread('thread', [optimistic])
    api.getThreadDetail.mockResolvedValue(snapshot('latest', { messages: [message('latest'), message('cmd', { turnId: 'latest' }), message('file', { turnId: 'latest', messageType: 'fileChange' })] }))
    test.commands.upsert('thread', message('cmd', { turnId: 'latest' }))
    test.files.set('thread', [message('file', { turnId: 'latest' })])
    await test.controller.loadMessages('thread')
    expect(test.commands.getMessages('thread')).toEqual([])
    expect(test.files.getMessages('thread')).toEqual([])
    api.getOlderThreadMessages.mockResolvedValue({ ...page('older'), turnIndexByTurnId: { older: 0, empty: 1 } })
    await test.controller.loadOlderMessages()
    expect(api.getOlderThreadMessages).toHaveBeenCalledExactlyOnceWith('thread', 'latest', undefined, { source: 'native', nextCursor: 'opaque/+' })
    test.controller.history.markDirty('thread')
    api.getThreadDetail.mockResolvedValue(snapshot('latest', { hasMoreOlder: false }))
    await test.controller.loadMessages('thread', { silent: true })
    expect(test.controller.persistedMessagesByThreadId.value.thread.map(row => row.id)).toEqual(['older', 'latest', 'cmd', 'file', optimistic.id])
    expect(test.turnOrder.getLookup('thread')).toEqual({ older: 0, empty: 1, latest: 2 })
    expect(test.controller.hasMoreOlderMessagesByThreadId.value.thread).toBe(true)
  })

  it('rejects both old account snapshots during an A to B to A transition', async () => {
    const test = setup()
    const a = deferred<ThreadReadDetail>()
    const b = deferred<ThreadReadDetail>()
    api.getThreadDetail.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockResolvedValue(snapshot('current-A'))
    const oldA = test.controller.loadMessages('thread')
    const joinedA = test.controller.loadMessages('thread')
    test.switchAccount()
    const oldB = test.controller.loadMessages('thread')
    test.switchAccount()
    await test.controller.loadMessages('thread')
    a.resolve(snapshot('stale-A'))
    b.reject(new Error('stale-B'))
    await Promise.all([oldA, joinedA, oldB])
    expect(test.controller.persistedMessagesByThreadId.value.thread.map(row => row.text)).toEqual(['current-A'])
    expect(test.metadata.setModel).toHaveBeenCalledTimes(1)
    expect(test.errors.size).toBe(0)
    expect(api.getThreadDetail).toHaveBeenCalledTimes(3)
  })

  it('does not invalidate or resume a stale missing-thread detail read', async () => {
    const test = setup()
    test.controller.markResumed('thread')
    const old = deferred<ThreadReadDetail>()
    api.getThreadDetail.mockReturnValue(old.promise)
    const load = test.controller.loadMessages('thread')
    test.switchAccount()
    old.reject(new Error('thread not loaded'))
    await load
    expect(api.invalidateThreadResumeCache).not.toHaveBeenCalled()
    expect(api.resumeThread).not.toHaveBeenCalled()
    expect(test.errors.size).toBe(0)
  })

  it('lets explicit retry bypass the transient failure gate without silent refetch loops', async () => {
    const test = setup()
    api.getThreadDetail.mockRejectedValueOnce(new Error('temporary read failure')).mockResolvedValue(snapshot('recovered'))
    await expect(test.controller.loadMessages('thread')).rejects.toThrow('temporary read failure')
    await test.controller.loadMessages('thread', { silent: true })
    await test.controller.loadMessages('thread')
    expect(api.getThreadDetail).toHaveBeenCalledTimes(1)
    await test.controller.loadMessages('thread', { retry: true })
    expect(api.getThreadDetail).toHaveBeenCalledTimes(2)
    expect(test.errors.size).toBe(0)
  })

  it('reuses committed rows passed through the projection and removes redundant compaction errors', () => {
    const test = setup()
    const canonical = message('turn-compaction', { turnId: 'turn', messageType: 'contextCompaction', compaction: { status: 'failed', error: 'failure' } })
    test.controller.setPersistedMessagesForThread('thread', [canonical, message('redundant-error', { turnId: 'turn', messageType: 'turnError' })])
    const previous = test.controller.persistedMessagesByThreadId.value.thread
    test.controller.setPersistedMessagesForThread('thread', previous)
    expect(test.controller.persistedMessagesByThreadId.value.thread).toBe(previous)
    expect(previous).toHaveLength(1)
    expect(test.deliveries.observe).toHaveBeenCalledTimes(2)
    test.controller.prune(new Set())
    expect(test.controller.persistedMessagesByThreadId.value).toEqual({})
  })

  it('isolates ten stopped reads without scheduling a refresh or retaining a visible snapshot', async () => {
    const test = setup()
    for (let index = 0; index < 10; index++) {
      const pending = deferred<ThreadReadDetail>()
      api.getThreadDetail.mockReturnValueOnce(pending.promise)
      const load = test.controller.loadMessages('thread')
      test.controller.history.markDirty('thread')
      test.controller.stop()
      pending.resolve(snapshot(`late-${index}`))
      await load
      expect(test.controller.persistedMessagesByThreadId.value).toEqual({})
      expect(test.controller.loadingMessagesByThreadId.value).toEqual({})
    }
    expect(api.getThreadDetail).toHaveBeenCalledTimes(10)
    expect(test.scheduleEventSync).not.toHaveBeenCalled()
    expect(test.metadata.setModel).not.toHaveBeenCalled()
  })

  it('owns snapshot fallback, independent pruning and the final teardown reset', async () => {
    const test = setup()
    const thread = { id: 'thread', title: 'History fallback', projectName: 'project', cwd: '/fixture', hasWorktree: false,
      createdAtIso: '', updatedAtIso: '', preview: '', unread: false, inProgress: false }
    api.getThreadDetail.mockResolvedValue(snapshot('turn', { thread }))
    api.getThreadDetail.mockResolvedValue(snapshot('turn', { thread }))
    await test.controller.loadMessages('thread')
    expect(test.controller.getSnapshot('thread')).toEqual(thread)
    test.controller.pruneSnapshots(new Set(['thread']))
    expect(test.controller.getSnapshot('thread')?.title).toBe('History fallback')
    test.controller.pruneSnapshots(new Set())
    expect(test.controller.getSnapshot('thread')).toBeUndefined()
    test.controller.stop()
    await test.controller.loadMessages('thread')
    test.controller.stop()
    expect(test.controller.getSnapshot('thread')).toEqual(thread)
    test.controller.resetSnapshots()
    expect(test.controller.getSnapshot('thread')).toBeUndefined()
  })
})
