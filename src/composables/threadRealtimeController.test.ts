import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcNotification } from '../api/codexRpcClient'
import type { ThreadReadDetail } from '../api/threadReadGateway'
import { combineHistoryAndLive } from '../messageIdentity'
import { createThreadActiveTurnState } from './threadActiveTurnState'
import { createThreadHistoryController } from './threadHistoryController'
import { createThreadRealtimeController } from './threadRealtimeController'
import { createThreadTurnOrderState } from './threadTurnOrderState'

const api = vi.hoisted(() => ({
  resumeThread: vi.fn(),
  getThreadDetail: vi.fn(),
  getOlderThreadMessages: vi.fn(),
  invalidateThreadResumeCache: vi.fn(),
  persistThreadTitle: vi.fn(),
  invalidateModelCatalog: vi.fn(),
}))
vi.mock('../api/threadReadGateway', () => api)
vi.mock('../api/threadPreferencesGateway', () => ({ persistThreadTitle: api.persistThreadTitle }))
vi.mock('../api/modelCatalog', () => ({ invalidateModelCatalog: api.invalidateModelCatalog }))

function setup() {
  let selectedThreadId = 'thread'
  let history!: ReturnType<typeof createThreadHistoryController>
  const turnOrder = createThreadTurnOrderState({ turnIndexByTurnIdByThreadId: ref({}) })
  const activeTurn = createThreadActiveTurnState({ turnIdByThreadId: ref({}) })
  const progress = new Map<string, boolean>()
  const status = {
    setInProgress: vi.fn((id: string, running: boolean) => { progress.set(id, running) }),
    setActivity: vi.fn(),
    setSummary: vi.fn(),
    setError: vi.fn(),
    clearTransientError: vi.fn(),
    setPageError: vi.fn(),
  }
  const metadata = {
    markSearchChanged: vi.fn(),
    refreshModels: vi.fn(async () => {}),
    setAuthRecovery: vi.fn(),
    setReportedModel: vi.fn(),
    setTitle: vi.fn(),
    markQuotaUpdated: vi.fn(),
    scheduleQuotaRefresh: vi.fn(),
    getQuotaSnapshot: vi.fn(() => null),
    applyQuotaSnapshot: vi.fn(),
    setTokenUsage: vi.fn(),
  }
  const scheduleQueueRefresh = vi.fn()
  const clearDelayedTurnSync = vi.fn()
  const unblockInterrupt = vi.fn()
  const controller = createThreadRealtimeController({
    getSelectedThreadId: () => selectedThreadId,
    history: {
      getMessages: id => history.persistedMessagesByThreadId.value[id] ?? [],
      setMessages: (id, messages) => history.setPersistedMessagesForThread(id, messages),
    },
    turns: {
      getIndex: turnOrder.getTurnIndex,
      setIndex: turnOrder.set,
      inferNextIndex: id => turnOrder.nextTurnIndex(id, history.persistedMessagesByThreadId.value[id] ?? []),
      getActiveTurnId: activeTurn.getTurnId,
      setActiveTurnId: activeTurn.setTurnId,
      clearActiveTurn: activeTurn.clear,
      unblockInterrupt,
    },
    status,
    metadata,
    handleServerRequest: vi.fn(event => event.method.startsWith('server/request')),
    scheduleQueueRefresh,
    clearDelayedTurnSync,
  })
  history = createThreadHistoryController({
    getAccountRevision: () => 0,
    getSelectedThreadId: () => selectedThreadId,
    getThreadVersion: () => 'version',
    reuseMs: 2000,
    metadata: { setProvider: vi.fn(), setModel: vi.fn() },
    status: {
      isInProgress: id => progress.get(id) === true,
      setInProgress: status.setInProgress,
      hasTransientError: () => false,
      setTransientError: vi.fn(),
      clearTransientError: status.clearTransientError,
      setPageError: status.setPageError,
    },
    turns: {
      getLookup: turnOrder.getLookup,
      replaceLookup: turnOrder.replace,
      markMessagesPersisted: vi.fn(),
      rebindLiveFileChanges: id => controller.fileChanges.rebindTurnIndices(id, turnOrder.getLookup(id)),
      getActiveTurnId: activeTurn.getTurnId,
      setActiveTurnId: activeTurn.setTurnId,
      clearActiveTurn: activeTurn.clear,
    },
    live: {
      getAgentMessages: controller.agents.getMessages,
      setAgentMessages: controller.agents.set,
      clearAgentMessages: controller.agents.clear,
      removePersistedCommands: controller.commands.removePersistedIn,
      removePersistedFileChanges: controller.fileChanges.removePersistedIn,
      clearCompleted: vi.fn(),
    },
    deliveries: { refresh: vi.fn(), refreshReceipts: vi.fn(async () => {}), observe: vi.fn() },
    scheduleEventSync: vi.fn(),
  })
  const send = (method: string, params: unknown) => controller.handle({ method, params, atIso: '2026-10-11T10:00:00Z' } as RpcNotification)
  const item = (method: string, value: Record<string, unknown>, threadId = 'thread', turnId = 'turn') => send(method, { threadId, turnId, item: value })
  const messages = (id = 'thread') => combineHistoryAndLive(history.persistedMessagesByThreadId.value[id] ?? [], [
    ...controller.plans.getMessages(id), ...controller.commands.getMessages(id),
    ...controller.fileChanges.getMessages(id), ...controller.agents.getMessages(id),
  ])
  return { controller, history, status, metadata, send, item, messages, progress, activeTurn, turnOrder, scheduleQueueRefresh, clearDelayedTurnSync, unblockInterrupt,
    select: (id: string) => { selectedThreadId = id },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', {})
})
afterEach(() => { vi.unstubAllGlobals() })

describe('complete realtime notification owner', () => {
  it('commits streaming deltas and clears reasoning when the selected response begins', () => {
    const test = setup()
    test.send('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
    test.item('item/started', { id: 'reason', type: 'reasoning' })
    test.send('item/reasoning/summaryTextDelta', { threadId: 'thread', itemId: 'reason', delta: 'thinking' })
    expect(test.controller.reasoning.getText('thread')).toBe('thinking')
    for (let index = 0; index < 30; index++) {
      test.send('item/agentMessage/delta', { threadId: 'thread', itemId: 'response', delta: 'a' })
    }
    expect(test.controller.reasoning.getText('thread')).toBe('')
    expect(test.messages().find(row => row.id === 'response')).toMatchObject({ text: 'a'.repeat(30), turnId: 'turn' })
    test.item('item/completed', { id: 'response', type: 'agentMessage', text: 'complete' })
    expect(test.messages().filter(row => row.id === 'response')).toHaveLength(1)
    expect(test.messages().find(row => row.id === 'response')?.text).toBe('complete')
    expect(api.resumeThread).not.toHaveBeenCalled()
    expect(api.getThreadDetail).not.toHaveBeenCalled()
  })

  it('updates background turn status and plans without receiving its response stream', () => {
    const test = setup()
    test.send('turn/started', { thread_id: 'background', turn: { id: 'other' } })
    test.send('turn/plan/updated', { threadId: 'background', turnId: 'other', plan: [{ step: 'verify', status: 'in_progress' }] })
    test.send('item/plan/delta', { threadId: 'background', turnId: 'other', delta: ' more' })
    test.send('item/agentMessage/delta', { threadId: 'background', itemId: 'response', delta: 'hidden' })
    expect(test.progress.get('background')).toBe(true)
    expect(test.controller.plans.getMessages('background')[0]).toMatchObject({ text: '- [~] verify more', plan: { steps: [{ step: 'verify', status: 'inProgress' }] } })
    expect(test.controller.agents.getMessages('background')).toEqual([])
    test.select('background')
    test.send('item/agentMessage/delta', { threadId: 'background', itemId: 'response', delta: 'visible' })
    expect(test.messages('background').find(row => row.id === 'response')?.text).toBe('visible')
  })

  it('shares turn ordering with history and removes persisted command and file overlays', async () => {
    const test = setup()
    test.send('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
    test.item('item/started', { id: 'command', type: 'commandExecution', command: 'pwd', cwd: '/fixture' })
    test.send('item/commandExecution/outputDelta', { threadId: 'thread', itemId: 'command', delta: '/fixture' })
    test.item('item/completed', { id: 'command', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/fixture', exitCode: 0 })
    test.item('item/completed', { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: '/fixture/a', kind: { type: 'add' }, diff: '+a' }] })
    const live = test.messages()
    expect(live.map(row => [row.id, row.turnIndex])).toEqual([['command', 0], ['file', 0]])
    api.getThreadDetail.mockResolvedValue({ messages: live, inProgress: false, model: '', modelProvider: '', activeTurnId: '', turnIndexByTurnId: { turn: 0 }, hasMoreOlder: false } satisfies ThreadReadDetail)
    await test.history.loadMessages('thread')
    expect(api.getThreadDetail).toHaveBeenCalledTimes(1)
    expect(api.resumeThread).not.toHaveBeenCalled()
    expect(test.controller.commands.getMessages('thread')).toEqual([])
    expect(test.controller.fileChanges.getMessages('thread')).toEqual([])
    expect(test.messages().map(row => row.id)).toEqual(['command', 'file'])
  })

  it('rejects old turn completion and ended start replays while keeping the current turn', () => {
    const test = setup()
    test.send('turn/started', { threadId: 'thread', turn: { id: 'old' } })
    test.send('turn/started', { threadId: 'thread', turn: { id: 'new' } })
    test.send('turn/completed', { threadId: 'thread', turn: { id: 'old', durationMs: 10 } })
    expect(test.activeTurn.getTurnId('thread')).toBe('new')
    expect(test.status.setSummary).not.toHaveBeenCalledWith('thread', expect.objectContaining({ turnId: 'old' }))
    test.send('turn/completed', { threadId: 'thread', turn: { id: 'new', durationMs: 15 } })
    const count = test.unblockInterrupt.mock.calls.length
    test.send('turn/started', { threadId: 'thread', turn: { id: 'new' } })
    expect(test.progress.get('thread')).toBe(false)
    expect(test.unblockInterrupt).toHaveBeenCalledTimes(count)
    expect(test.status.setSummary).toHaveBeenLastCalledWith('thread', { turnId: 'new', durationMs: 15 })
    expect(test.clearDelayedTurnSync).toHaveBeenCalledWith('thread')
  })

  it('distinguishes retry errors and final failed turns without clearing the current error event', () => {
    const test = setup()
    test.send('error', { threadId: 'thread', message: 'retry transport', willRetry: true })
    expect(test.status.setError).toHaveBeenLastCalledWith('thread', 'retry transport', { transient: true })
    expect(test.status.clearTransientError).not.toHaveBeenCalled()
    test.send('item/agentMessage/delta', { threadId: 'thread', itemId: 'response', delta: 'recovered' })
    expect(test.status.clearTransientError).toHaveBeenCalledWith('thread')
    test.send('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'final failure' } } })
    expect(test.status.setError).toHaveBeenLastCalledWith('thread', 'final failure')
    expect(test.status.setPageError).toHaveBeenLastCalledWith('final failure')
  })

  it('merges optimistic user acknowledgements and preserves normalized images and questions', () => {
    const test = setup()
    test.history.setPersistedMessagesForThread('thread', [{ id: 'optimistic-user:send', role: 'user', text: 'hello', turnId: 'turn', messageType: 'userMessage.optimistic' }])
    test.item('item/completed', { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] })
    expect(test.messages().filter(row => row.role === 'user')).toHaveLength(1)
    test.item('item/completed', { id: 'image', type: 'imageView', path: '/fixture/a b.png' })
    test.item('item/completed', { id: 'generated', type: 'imageGeneration', result: 'aGVsbG8=' })
    expect(test.messages().find(row => row.id === 'image')?.images).toEqual(['/codex-local-image?path=%2Ffixture%2Fa%20b.png'])
    expect(test.messages().find(row => row.id === 'generated')?.images).toEqual(['data:image/png;base64,aGVsbG8='])
    test.item('item/completed', { id: 'question', type: 'agentMessage', text: '', delivery: 'async', questions: [{ title: 'Continue?', options: ['Yes'] }] })
    expect(test.messages().find(row => row.id === 'question')).toMatchObject({ delivery: 'async', questions: [{ title: 'Continue?', options: ['Yes'] }] })
  })

  it('does not downgrade completed compaction or subtask messages when starts replay', () => {
    const test = setup()
    test.item('item/completed', { id: 'compact', type: 'contextCompaction' })
    test.item('item/started', { id: 'compact', type: 'contextCompaction' })
    expect(test.messages().find(row => row.id === 'compact')?.compaction?.status).toBe('completed')
    test.item('item/completed', { id: 'task', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['worker'], prompt: 'fixture' })
    test.item('item/started', { id: 'task', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['worker'], prompt: 'fixture' })
    expect(test.messages().find(row => row.id === 'task')?.subtask?.status).toBe('completed')
  })

  it('routes metadata and token usage through narrow commands and keeps early returns', () => {
    const test = setup()
    test.send('model/list/updated', {})
    expect(api.invalidateModelCatalog).toHaveBeenCalledTimes(1)
    expect(test.metadata.refreshModels).toHaveBeenCalledTimes(1)
    test.send('thread/name/updated', { threadId: 'thread', threadName: 'named' })
    expect(test.metadata.setTitle).toHaveBeenCalledWith('thread', 'named')
    expect(api.persistThreadTitle).toHaveBeenCalledWith('thread', 'named')
    test.send('model/rerouted', { threadId: 'thread', turnId: 'turn', toModel: 'fixture-model' })
    expect(test.metadata.setReportedModel).toHaveBeenCalledWith('thread', 'fixture-model')
    test.send('modelProvider/authRecoveryStarted', { threadId: 'thread', turnId: 'turn', provider: 'fixture', message: 'retry auth' })
    expect(test.metadata.setAuthRecovery).toHaveBeenLastCalledWith('thread', expect.objectContaining({ phase: 'started', provider: 'fixture' }))
    test.send('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
    expect(test.metadata.setAuthRecovery).toHaveBeenLastCalledWith('thread', null)
    const usage = { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 2 }
    test.send('thread/tokenUsage/updated', { thread_id: 'thread', token_usage: { total: usage, last: usage, model_context_window: 100 } })
    expect(test.metadata.setTokenUsage).toHaveBeenCalledWith('thread', expect.objectContaining({ currentContextTokens: 30, remainingContextTokens: 70, remainingContextPercent: 70 }))
    test.send('thread/tokenUsage/updated', { threadId: 'thread', tokenUsage: { total: { totalTokens: '30' }, last: usage } })
    expect(test.metadata.setTokenUsage).toHaveBeenCalledTimes(1)
    const clearCount = test.status.clearTransientError.mock.calls.length
    test.send('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 5, windowDurationMins: 60 } } })
    expect(test.metadata.markQuotaUpdated).toHaveBeenCalledTimes(1)
    expect(test.metadata.applyQuotaSnapshot).toHaveBeenCalledTimes(1)
    expect(test.status.clearTransientError).toHaveBeenCalledTimes(clearCount)
  })

  it('stops receipt of old notifications, resets private live state and restarts turn tracking', () => {
    const test = setup()
    for (let index = 0; index < 10; index++) {
      test.controller.start()
      test.send('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
      test.send('item/agentMessage/delta', { threadId: 'thread', itemId: 'response', delta: 'before' })
      test.send('turn/completed', { threadId: 'thread', turn: { id: 'turn' } })
      test.controller.stop()
      test.controller.resetLiveState()
      test.send('item/agentMessage/delta', { threadId: 'thread', itemId: 'response', delta: 'late' })
      expect(test.controller.agents.getMessages('thread')).toEqual([])
    }
    expect(test.unblockInterrupt).toHaveBeenCalledTimes(10)
    expect(api.resumeThread).not.toHaveBeenCalled()
    expect(api.getThreadDetail).not.toHaveBeenCalled()
  })

  it('prunes only retired live state and ignores malformed events', () => {
    const test = setup()
    test.send('item/agentMessage/delta', { threadId: 'thread', itemId: 'response', delta: 'keep' })
    test.send('turn/plan/updated', { threadId: 'retired', turnId: 'other', plan: [{ step: 'retire', status: 'pending' }] })
    test.controller.pruneLiveState(new Set(['thread']))
    test.item('item/completed', { type: 'fileChange', changes: [], status: 'failed' })
    test.send('turn/started', null)
    test.send('thread/tokenUsage/updated', [])
    expect(test.controller.plans.getMessages('retired')).toEqual([])
    expect(test.messages().map(row => row.text)).toEqual(['keep'])
  })
})
