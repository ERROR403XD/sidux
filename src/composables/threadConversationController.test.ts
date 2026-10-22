import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createThreadConversationController } from './threadConversationController'
import type { UiMessage, UiServerRequest } from '../types/codex'
import type { ConversationDelivery } from '../conversationDelivery'
import type { TurnSummaryState } from '../turnSummary'
import type { AuthRecoveryState } from '../authRecovery'

const message = (id: string, role: UiMessage['role'] = 'user', extra: Partial<UiMessage> = {}): UiMessage => ({ id, role, text: id, turnId: 'turn', ...extra })
const request = (id: number, threadId: string, receivedAtIso: string): UiServerRequest => ({ id, threadId, receivedAtIso, method: 'approval', turnId: '', itemId: '', params: null })
const delivery = (id: string, extra: Partial<ConversationDelivery> = {}): ConversationDelivery => ({
  id, threadId: 'a', turnId: 'turn', status: 'accepted', createdAt: 1,
  message: { id, text: id, imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' }, ...extra,
})
function setup() {
  const selected = ref('a')
  const persisted = ref<Record<string, UiMessage[]>>({ a: [], b: [] })
  const plans = ref<UiMessage[]>([]), agents = ref<UiMessage[]>([]), commands = ref<UiMessage[]>([]), files = ref<UiMessage[]>([])
  const summary = ref<TurnSummaryState>()
  const rows = ref<ConversationDelivery[]>([])
  const requests = ref<Record<string, UiServerRequest[]>>({})
  const auth = ref<AuthRecoveryState | null>(null)
  const loading = ref(false), older = ref(false), loadingOlder = ref(false)
  const getMessages = vi.fn((id: string) => persisted.value[id] ?? [])
  const setMessages = vi.fn((id: string, messages: readonly UiMessage[]) => { persisted.value[id] = [...messages] })
  const project = vi.fn((_id: string, messages: UiMessage[]) => messages)
  const controller = createThreadConversationController({
    getSelectedThreadId: () => selected.value,
    history: { getMessages, setMessages, isLoading: () => loading.value, hasMoreOlder: () => older.value, isLoadingOlder: () => loadingOlder.value },
    live: { getPlans: () => plans.value, getAgents: () => agents.value, getCommands: () => commands.value, getFileChanges: () => files.value },
    getSummary: () => summary.value,
    deliveries: { project, getRows: () => rows.value },
    pending: { getRequests: id => requests.value[id] ?? [], getAuthRecovery: () => auth.value },
  })
  return { controller, selected, persisted, plans, agents, commands, files, summary, rows, requests, auth,
    loading, older, loadingOlder, getMessages, setMessages, project }
}

describe('conversation projection owner', () => {
  it('combines the current history and live domains, inserts summary, then applies deliveries once', () => {
    const test = setup()
    test.persisted.value.a = [message('prompt'), message('assistant', 'assistant')]
    test.plans.value = [message('plan', 'assistant', { messageType: 'plan' })]
    test.commands.value = [message('command', 'assistant', { messageType: 'commandExecution' })]
    test.files.value = [message('file', 'assistant', { messageType: 'fileChange' })]
    test.agents.value = [message('agent', 'assistant', { messageType: 'agentMessage.live' })]
    test.summary.value = { turnId: 'turn', durationMs: 1000 }
    test.project.mockImplementation((_id, messages) => [...messages, message('delivery')])
    const visible = test.controller.messages.value
    expect(visible.map(row => row.id)).toEqual(expect.arrayContaining(['prompt', 'assistant', 'plan', 'command', 'file', 'agent', 'turn-summary:turn', 'delivery']))
    expect(visible.at(-1)?.id).toBe('delivery')
    expect(test.project).toHaveBeenCalledOnce()
    expect(test.project.mock.calls[0]?.[0]).toBe('a')
    expect(test.controller.messages.value).toBe(visible)
    expect(test.getMessages).toHaveBeenCalledOnce()
    test.selected.value = 'b'
    test.summary.value = undefined
    test.plans.value = test.commands.value = test.files.value = test.agents.value = []
    expect(test.controller.messages.value.map(row => row.id)).toEqual(['delivery'])
    expect(test.project.mock.calls[1]?.[0]).toBe('b')
  })

  it('avoids history and delivery work without a selected conversation and projects loading and auth reactively', () => {
    const test = setup()
    test.loading.value = test.older.value = test.loadingOlder.value = true
    test.auth.value = { threadId: 'a', turnId: 'turn', provider: 'provider', message: 'Refreshing', phase: 'started' }
    expect(test.controller.isLoadingMessages.value).toBe(true)
    expect(test.controller.hasMoreOlderMessages.value).toBe(true)
    expect(test.controller.isLoadingOlderMessages.value).toBe(true)
    expect(test.controller.selectedAuthRecovery.value?.phase).toBe('started')
    test.selected.value = ''
    expect(test.controller.messages.value).toEqual([])
    expect(test.controller.hasMoreOlderMessages.value).toBe(false)
    expect(test.controller.isLoadingOlderMessages.value).toBe(false)
    expect(test.getMessages).not.toHaveBeenCalled()
    expect(test.project).not.toHaveBeenCalled()
  })

  it('merges selected and global requests in timestamp order without changing source arrays', () => {
    const test = setup()
    test.requests.value = { a: [request(1, 'a', '2026-10-12T02:00:00Z')], b: [request(2, 'b', '2026-10-12T00:00:00Z')],
      __global__: [request(3, '__global__', '2026-10-12T01:00:00Z')] }
    expect(test.controller.selectedThreadServerRequests.value.map(row => row.id)).toEqual([3, 1])
    expect(test.requests.value.a).toHaveLength(1)
    test.selected.value = 'b'
    expect(test.controller.selectedThreadServerRequests.value.map(row => row.id)).toEqual([2, 3])
    test.selected.value = ''
    expect(test.controller.selectedThreadServerRequests.value.map(row => row.id)).toEqual([3])
  })

  it('keeps optimistic identity and copies submitted attachments while selection changes', () => {
    const test = setup()
    test.selected.value = 'b'
    const images = ['image'], skills = [{ name: 'skill', path: '/skill' }], files = [{ label: 'file', path: 'file', fsPath: '/file' }]
    test.controller.appendOptimisticUserMessage('a', 'Prompt', images, skills, files, { id: 'intent', turnId: 'turn', userMessageOrdinal: 2 })
    images[0] = 'changed'; skills[0]!.name = 'changed'; files[0]!.label = 'changed'
    expect(test.persisted.value.a?.[0]).toMatchObject({ id: 'optimistic-user:intent', clientUserMessageId: 'intent', userMessageOrdinal: 2,
      turnId: 'turn', text: 'Prompt', images: ['image'], skills: [{ name: 'skill' }], fileAttachments: [{ label: 'file' }] })
    expect(test.persisted.value.b).toEqual([])
  })

  it('replaces the same optimistic ID and suppresses a duplicate after native identity evidence', () => {
    const test = setup()
    const identity = { id: 'intent', turnId: 'turn', userMessageOrdinal: 0 }
    test.controller.appendOptimisticUserMessage('a', 'First', [], [], [], identity)
    test.controller.appendOptimisticUserMessage('a', 'Edited', [], [], [], identity)
    expect(test.persisted.value.a).toHaveLength(1)
    expect(test.persisted.value.a?.[0]?.text).toBe('Edited')
    test.persisted.value.a = [message('native', 'user', { text: 'Edited', clientUserMessageId: 'intent' })]
    const writes = test.setMessages.mock.calls.length
    test.controller.appendOptimisticUserMessage('a', 'Edited', [], [], [], identity)
    expect(test.setMessages).toHaveBeenCalledTimes(writes)
  })

  it('counts ordinals only for the requested conversation and source turn with accepted deliveries', () => {
    const test = setup()
    test.persisted.value.a = [message('user'), message('agent', 'assistant'), message('old', 'user', { turnId: 'old' })]
    test.rows.value = [delivery('accepted'), delivery('queued', { status: 'queued' }), delivery('other', { threadId: 'b' }), delivery('old', { turnId: 'old' })]
    expect(test.controller.readNextUserMessageOrdinal('a', 'turn')).toBe(2)
    expect(test.controller.readNextUserMessageOrdinal('a', 'old')).toBe(2)
    expect(test.controller.readNextUserMessageOrdinal('a', 'new')).toBe(0)
    expect(test.controller.readNextUserMessageOrdinal('a')).toBe(0)
  })

  it('owns the search invalidation version independently of selection and computed reads', () => {
    const test = setup()
    expect(test.controller.threadSearchVersion.value).toBe(0)
    test.controller.markSearchChanged()
    test.selected.value = 'b'
    void test.controller.messages.value
    expect(test.controller.threadSearchVersion.value).toBe(1)
    test.controller.markSearchChanged()
    expect(test.controller.threadSearchVersion.value).toBe(2)
  })
})
