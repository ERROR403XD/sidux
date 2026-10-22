import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { UiMessage } from '../types/codex'
import type { ThreadQueueOperation } from '../threadQueue'
import { createThreadSendController, type ThreadSendControllerOptions } from './threadSendController'
import { createThreadModelController } from './threadModelController'
import { normalizeModelCapability } from '../modelCapabilities'
import { WEB_CONVERSATION_PREFERENCES_KEY } from '../webConversationPreferences'

const api = vi.hoisted(() => ({ create: vi.fn(), turn: vi.fn(), resume: vi.fn(), detail: vi.fn(), turns: vi.fn() }))
vi.mock('../api/threadCommandGateway', () => ({ startThread: api.create, startThreadTurn: api.turn, getCurrentModelConfig: vi.fn(), getAvailableModels: vi.fn() }))
vi.mock('../api/threadReadGateway', () => ({ resumeThread: api.resume, getThreadDetail: api.detail, getThreadTurnMessages: api.turns }))
vi.mock('../api/modelCatalog', () => ({ invalidateModelCatalog: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function setup() {
  let account = 0
  const selection = { threadId: 'thread', mode: 'plan' as const, settingsUpdating: false }
  const messages = new Map<string, readonly UiMessage[]>()
  const resumed = new Set<string>()
  const inProgress = new Set<string>()
  const ports: ThreadSendControllerOptions = {
    getAccountRevision: () => account,
    isModelSettingsUpdating: () => selection.settingsUpdating,
    newThreadModelContext: '__new-thread__', modelFallbackId: 'fallback',
    selection: {
      getThreadId: () => selection.threadId, getCollaborationMode: () => selection.mode,
      getReasoningEffort: () => 'high', getSpeedMode: () => '',
      setThreadId: vi.fn(value => { selection.threadId = value }),
      setModelProjection: vi.fn(), setCollaborationMode: vi.fn(),
    },
    model: {
      readId: () => 'model', readProviderId: () => 'provider', getActiveProviderId: () => 'provider',
      getSettings: () => ({ model: 'model', effort: 'high', serviceTier: null }),
      setId: vi.fn(), setProviderId: vi.fn(), resolveForProvider: (_id, model) => model,
      getCatalog: () => [], setCatalog: vi.fn(), ensureAvailableIds: vi.fn(),
    },
    preferences: { getNewThreadChoice: () => undefined, register: vi.fn(), saveModelSettings: vi.fn() },
    history: {
      getMessages: id => messages.get(id) ?? [], getLiveMessages: () => [],
      setMessages: vi.fn((id, rows) => { messages.set(id, rows) }),
      isResumed: id => resumed.has(id), markResumed: vi.fn(id => { resumed.add(id) }), markDirty: vi.fn(),
    },
    turn: {
      isInProgress: id => inProgress.has(id), setInProgress: vi.fn((id, running) => { if (running) inProgress.add(id); else inProgress.delete(id) }),
      getActiveId: () => 'source-turn', setActiveId: vi.fn(),
      setSummary: vi.fn(), setActivity: vi.fn(), setError: vi.fn(), blockInterrupt: vi.fn(), unblockInterrupt: vi.fn(),
    },
    queue: { getMessages: () => [], commit: vi.fn(async () => ({ state: {} })), refresh: vi.fn(async () => {}) },
    conversationDeliveries: { begin: vi.fn(), patch: vi.fn(), replaceId: vi.fn(), refresh: vi.fn(), observe: vi.fn() },
    getDeliveryRows: () => [], readNextUserMessageOrdinal: () => 3,
    appendOptimisticUserMessage: vi.fn(), insertOptimisticThread: vi.fn(), requestThreadTitleGeneration: vi.fn(async () => {}),
    setPageError: vi.fn(), syncFromNotifications: vi.fn(async () => {}), scheduleDelayedTurnSync: vi.fn(),
  }
  const controller = createThreadSendController(ports)
  return { controller, ports, selection, messages, resumed, inProgress,
    changeAccount: () => { account++; controller.invalidateForAccountChange() },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  api.create.mockResolvedValue({ threadId: 'created', model: 'model', modelProvider: 'provider' })
  api.resume.mockResolvedValue({ model: 'model', modelProvider: 'provider' })
  api.turn.mockResolvedValue('new-turn')
})

describe('thread send controller', () => {
  it('submits current model/mode/attachments and completes history sync before scheduling', async () => {
    const test = setup()
    const sync = deferred<void>()
    vi.mocked(test.ports.syncFromNotifications).mockReturnValue(sync.promise)
    const send = test.controller.sendMessageToSelectedThread(' prompt ', ['image'], [{ name: 'skill', path: '/skill' }], 'queue', [{ label: 'file', path: '/file', fsPath: '/file' }])
    await vi.waitFor(() => expect(test.ports.history.markDirty).toHaveBeenCalledExactlyOnceWith('thread'))
    expect(api.resume).toHaveBeenCalledTimes(1)
    expect(api.turn).toHaveBeenCalledWith('thread', 'prompt', ['image'], 'model', 'high', [{ name: 'skill', path: '/skill' }], [{ label: 'file', path: '/file', fsPath: '/file' }], 'plan', null, 'immediate', expect.objectContaining({ id: expect.any(String) }))
    expect(test.ports.appendOptimisticUserMessage).toHaveBeenCalledWith('thread', 'prompt', ['image'], [{ name: 'skill', path: '/skill' }], expect.any(Array), expect.objectContaining({ turnId: 'new-turn', userMessageOrdinal: 0 }))
    expect(test.ports.scheduleDelayedTurnSync).not.toHaveBeenCalled()
    sync.resolve()
    await send
    expect(test.ports.scheduleDelayedTurnSync).toHaveBeenCalledExactlyOnceWith('thread')
  })

  it('hands an in-progress queue insertion to the queue owner without resume or direct turn requests', async () => {
    const test = setup()
    test.inProgress.add('thread')
    test.ports.queue.getMessages = () => [{ id: 'next', text: '', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' }]
    await test.controller.sendMessageToSelectedThread('queue', [], [], 'queue', [], 0, 'default')
    expect(test.ports.queue.commit).toHaveBeenCalledOnce()
    const operation = vi.mocked(test.ports.queue.commit).mock.calls[0][0] as Extract<ThreadQueueOperation, { type: 'add' }>
    expect(operation).toMatchObject({ threadId: 'thread', beforeId: 'next', message: { text: 'queue', model: 'model', effort: 'high', collaborationMode: 'default' } })
    expect(api.resume).not.toHaveBeenCalled()
    expect(api.turn).not.toHaveBeenCalled()
  })

  it('reuses a local image for steering and preserves ordinal within the source turn', async () => {
    const test = setup()
    const image = '/codex-local-image?path=%2Fimage.png'
    test.messages.set('thread', [{ id: 'previous', role: 'user', text: 'image', images: [image] }])
    test.resumed.add('thread')
    test.inProgress.add('thread')
    api.turn.mockResolvedValue('source-turn')
    await test.controller.sendMessageToSelectedThread('save the attached image', [], [], 'steer')
    expect(api.turn.mock.calls[0][2]).toEqual([image])
    expect(test.ports.conversationDeliveries.begin).toHaveBeenCalledWith('thread', expect.objectContaining({ imageUrls: [image] }), 3, false, 'source-turn')
    expect(test.ports.conversationDeliveries.patch).toHaveBeenCalledWith(expect.any(String), { status: 'accepted', turnId: 'source-turn', userMessageOrdinal: 3 })
    expect(test.ports.appendOptimisticUserMessage).not.toHaveBeenCalled()
  })

  it('owns one new-thread slot and preserves attachment-only creation and title behavior', async () => {
    const test = setup()
    const turn = deferred<string>()
    api.turn.mockReturnValue(turn.promise)
    const sending = test.controller.sendMessageToNewThread('', '/project', [], [], [{ label: 'notes.txt', path: '/notes.txt', fsPath: '/notes.txt' }], 'project')
    await vi.waitFor(() => expect(api.turn).toHaveBeenCalledOnce())
    expect(await test.controller.sendMessageToNewThread('duplicate', '/project')).toBe('')
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(test.controller.isSendingMessage.value).toBe(true)
    expect(test.ports.insertOptimisticThread).toHaveBeenCalledWith('created', '/project', 'notes.txt', 'project')
    turn.resolve('new-turn')
    expect(await sending).toBe('created')
    expect(test.ports.requestThreadTitleGeneration).toHaveBeenCalledWith('created', '', '/project', 'notes.txt')
    expect(test.controller.isSendingMessage.value).toBe(false)
    if (false) {
      // @ts-expect-error the owner exposes a read-only projection
      test.controller.isSendingMessage.value = true
    }
  })

  it.each(['stop', 'account'])('releases the old creation token on %s and ignores its late failure', async kind => {
    const test = setup()
    const old = deferred<{ threadId: string }>()
    const current = deferred<{ threadId: string }>()
    api.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldSend = test.controller.sendMessageToNewThread('old', '/project')
    if (kind === 'stop') { test.controller.stop(); test.controller.start() }
    else test.changeAccount()
    const sending = test.controller.sendMessageToNewThread('current', '/project')
    old.reject(new Error('old failure'))
    expect(await oldSend).toBe('')
    expect(test.controller.isSendingMessage.value).toBe(true)
    expect(test.ports.setPageError).not.toHaveBeenCalledWith('old failure')
    current.resolve({ threadId: 'current-created' })
    expect(await sending).toBe('current-created')
  })

  it('does not resurrect a captured context across ten stop/start cycles or submit while stopped', async () => {
    const test = setup()
    for (let index = 0; index < 10; index++) {
      const old = test.controller.captureThreadSendContext()
      expect(old()).toBe(true)
      test.controller.stop()
      await test.controller.sendMessageToSelectedThread('stopped')
      expect(await test.controller.sendMessageToNewThread('stopped', '/project')).toBe('')
      test.controller.start()
      expect(old()).toBe(false)
      expect(test.controller.captureThreadSendContext()()).toBe(true)
    }
    expect(api.create).not.toHaveBeenCalled()
    expect(api.turn).not.toHaveBeenCalled()
    expect(api.resume).not.toHaveBeenCalled()
  })

  it('passes its lifecycle guard to API preparation without withdrawing an in-flight durable request', async () => {
    const test = setup()
    const turn = deferred<string>()
    api.turn.mockReturnValueOnce(turn.promise)
    const sending = test.controller.sendMessageToSelectedThread('prompt')
    await vi.waitFor(() => expect(api.turn).toHaveBeenCalledOnce())
    const canPrepare = api.turn.mock.calls[0][10].canPrepare
    expect(canPrepare()).toBe(true)
    test.controller.stop()
    test.controller.start()
    expect(canPrepare()).toBe(false)
    turn.resolve('old-accepted-turn')
    await sending
    expect(test.ports.appendOptimisticUserMessage).not.toHaveBeenCalled()
  })

  it('preserves explicit question ordinal, confirmed-delivery and duplicate-answer rules', async () => {
    const test = setup()
    const question: UiMessage = { id: 'q-native', turnId: 'source-turn', role: 'assistant', text: 'pick', questionOrdinal: 1, questions: [{ title: 'Fruit?', options: ['Pear'] }] }
    test.messages.set('thread', [{ ...question, id: 'item-1' }])
    api.detail.mockResolvedValue({ messages: [] })
    api.turns.mockResolvedValue([question])
    const reply = { threadId: 'thread', turnId: 'source-turn', itemId: 'item-1', questionOrdinal: 1, answers: ['Pear'] }
    await test.controller.answerAsyncQuestions(reply)
    expect(api.turns).toHaveBeenCalledExactlyOnceWith('thread', 'source-turn')
    expect(api.turn.mock.calls[0][1]).toContain('codexapp:question-reply')
    expect(api.turn.mock.calls[0][10]).toMatchObject({ requireConfirmed: true })
    test.messages.set('thread', [question, { id: 'answer', role: 'user', text: 'Pear', questionReply: { itemId: 'q-native', turnId: 'source-turn', questionOrdinal: 1 } }])
    await test.controller.answerAsyncQuestions({ ...reply, itemId: 'q-native' })
    expect(api.turn).toHaveBeenCalledTimes(1)
  })

  it('skips sends during model updates and keeps current creation failure recovery metadata', async () => {
    const test = setup()
    test.selection.settingsUpdating = true
    await test.controller.sendMessageToSelectedThread('skip')
    expect(await test.controller.sendMessageToNewThread('skip', '/project')).toBe('')
    expect(api.create).not.toHaveBeenCalled()
    test.selection.settingsUpdating = false
    api.turn.mockRejectedValueOnce(new Error('current failure'))
    await expect(test.controller.sendMessageToNewThread('prompt', '/project')).rejects.toMatchObject({ message: 'current failure', createdThreadId: 'created' })
    expect(test.controller.isSendingMessage.value).toBe(false)
    expect(test.ports.setPageError).toHaveBeenCalledWith('current failure')
  })
})

it('keeps the submitted conversation model settings when selection changes during resume', async () => {
  const f = setup()
  const storage = new Map([[WEB_CONVERSATION_PREFERENCES_KEY, JSON.stringify({
    defaults: null, remember: true, threads: {
      thread: { source: 'web', saved: { model: 'model', provider: 'codex', effort: 'high', tier: 'priority' } },
      'other-conversation': { source: 'web', saved: { model: 'model', provider: 'codex', effort: 'low', tier: '' } },
    },
  })]])
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } })
  const selected = ref('thread')
  const model = createThreadModelController({
    getAccountRevision: () => 0,
    getSelectedThreadId: () => selected.value,
    setPageError: vi.fn(), setCliMissingError: vi.fn(),
  })
  model.replaceCatalog([normalizeModelCapability({
    id: 'model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }],
    serviceTiers: [{ id: 'priority' }],
  }, 'codex')!])
  model.setThreadModelProviderId('thread', 'codex')
  model.setThreadModelProviderId('other-conversation', 'codex')
  model.projectSelectedThread('thread')
  Object.assign(f.ports.model, {
    readId: model.readModelIdForThread,
    getSettings: model.checkedModelSettings,
    setId: model.setThreadModelId,
    setProviderId: model.setThreadModelProviderId,
    resolveForProvider: model.resolveThreadModelForProvider,
  })
  try {
    expect(model.checkedModelSettings('model')).toEqual({ model: 'model', effort: 'high', serviceTier: 'priority' })
    const resumed = deferred<{model:string;modelProvider:string}>()
    api.resume.mockReturnValue(resumed.promise)
    const sending = f.controller.sendMessageToSelectedThread('continue A')
    expect(api.resume).toHaveBeenCalledExactlyOnceWith('thread')
    f.selection.threadId = 'other-conversation'
    selected.value = 'other-conversation'
    model.projectSelectedThread('other-conversation')
    resumed.resolve({model:'model',modelProvider:'codex'})
    await sending
    expect(api.turn).toHaveBeenCalledOnce()
    expect(api.turn.mock.calls[0].slice(0,5)).toEqual(['thread','continue A',[],'model','high'])
    expect(api.turn.mock.calls[0][8]).toBe('priority')
  } finally {
    model.stop()
    vi.unstubAllGlobals()
  }
})
