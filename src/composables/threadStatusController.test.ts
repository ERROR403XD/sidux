import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { UiMessage, UiProjectGroup } from '../types/codex'
import { createThreadStatusController } from './threadStatusController'

function setup() {
  const selected = ref('a')
  const messages = ref<Record<string, UiMessage[]>>({})
  const reasoning = ref<Record<string, string>>({})
  const hasNextPage = ref(false)
  const scheduleRemainingPages = vi.fn()
  const onChanged = vi.fn()
  const live = {
    getReasoningText: (id: string) => reasoning.value[id] ?? '',
    clearPlans: vi.fn(), clearCommands: vi.fn(), resetReasoningItem: vi.fn(),
    clearReasoning: vi.fn((id: string) => { delete reasoning.value[id] }),
  }
  const controller = createThreadStatusController({
    getSelectedThreadId: () => selected.value,
    getPersistedMessages: id => messages.value[id] ?? [],
    list: { hasNextPage: () => hasNextPage.value, scheduleRemainingPages },
    live, onChanged,
  })
  return { controller, selected, messages, reasoning, hasNextPage, scheduleRemainingPages, live, onChanged }
}
const user: UiMessage = { id: 'user', role: 'user', text: 'hello' }
const error = (id: string, text: string): UiMessage => ({ id, role: 'system', text, messageType: 'turnError' })
const groups = (running: boolean): UiProjectGroup[] => [{ projectName: 'p', threads: [{ id: 'a', title: '', cwd: '/p', projectName: 'p', hasWorktree: false, createdAtIso: '', updatedAtIso: '', preview: '', unread: false, inProgress: running }] }]

describe('running status and list snapshot versions', () => {
  it('advances the revision even for the same status so a stale list cannot overwrite live progress', () => {
    const test = setup()
    test.controller.setThreadInProgress('a', true)
    const snapshot = test.controller.captureRevisions()
    test.controller.setThreadInProgress('a', true)
    test.controller.applyListedStatuses(groups(false), snapshot)
    expect(test.controller.isInProgress('a')).toBe(true)
    expect(test.onChanged).toHaveBeenCalledOnce()
    expect(test.controller.captureRevisions().get('a')).toBe(2)
  })

  it('applies a current list and returns a detached revision snapshot', () => {
    const test = setup()
    const snapshot = test.controller.captureRevisions()
    test.controller.applyListedStatuses(groups(true), snapshot)
    expect(test.controller.isInProgress('a')).toBe(true)
    expect(snapshot.size).toBe(0)
    snapshot.set('a', 999)
    expect(test.controller.captureRevisions().get('a')).toBe(1)
  })

  it('cleans completed live state and resumes background pages only after the final running conversation stops', () => {
    const test = setup()
    test.hasNextPage.value = true
    test.controller.setThreadInProgress('a', true)
    test.controller.setThreadInProgress('b', true)
    test.controller.activeTurn.setTurnId('a', 'turn')
    test.controller.blockInterruptUntilThreadIsPersisted('a')
    test.controller.setTurnActivityForThread('a', { label: 'Thinking', details: [] })
    test.controller.setThreadInProgress('a', false)
    expect(test.controller.activeTurn.getTurnId('a')).toBeUndefined()
    expect(test.controller.isInterruptBlocked('a')).toBe(false)
    expect(test.controller.selectedLiveOverlay.value).toBeNull()
    expect(test.live.clearPlans).toHaveBeenCalledExactlyOnceWith('a')
    expect(test.live.clearReasoning).toHaveBeenCalledExactlyOnceWith('a')
    expect(test.live.clearCommands).toHaveBeenCalledExactlyOnceWith('a')
    expect(test.live.resetReasoningItem).toHaveBeenCalledOnce()
    expect(test.scheduleRemainingPages).not.toHaveBeenCalled()
    test.controller.setThreadInProgress('b', false)
    expect(test.scheduleRemainingPages).toHaveBeenCalledOnce()
    expect(test.live.resetReasoningItem).toHaveBeenCalledOnce()
  })

  it('does not repeat completion cleanup for an already idle conversation', () => {
    const test = setup()
    test.controller.setThreadInProgress('a', false)
    expect(test.controller.captureRevisions().get('a')).toBe(1)
    expect(test.live.clearCommands).not.toHaveBeenCalled()
    expect(test.onChanged).not.toHaveBeenCalled()
  })
})

describe('interrupt persistence gate', () => {
  it.each(['user-first', 'list-first'])('requires both a listed conversation and persisted user content: %s', order => {
    const { controller } = setup()
    controller.blockInterruptUntilThreadIsPersisted('a')
    expect(controller.isSelectedThreadInterruptPending.value).toBe(true)
    if (order === 'user-first') controller.markThreadMessagesPersisted('a', [user])
    else controller.markServerListedThreads(new Set(['a']))
    expect(controller.isInterruptBlocked('a')).toBe(true)
    if (order === 'user-first') controller.markServerListedThreads(new Set(['a']))
    else controller.markThreadMessagesPersisted('a', [user])
    expect(controller.isInterruptBlocked('a')).toBe(false)
    expect(controller.isSelectedThreadInterruptPending.value).toBe(false)
  })

  it('ignores other IDs and assistant-only persisted content', () => {
    const { controller } = setup()
    controller.blockInterruptUntilThreadIsPersisted('a')
    controller.markServerListedThreads(new Set(['b']))
    controller.markThreadMessagesPersisted('a', [{ id: 'agent', role: 'assistant', text: 'hello' }])
    controller.markThreadMessagesPersisted('b', [user])
    expect(controller.isInterruptBlocked('a')).toBe(true)
  })

  it('starts a new persistence gate without reusing the old listed/user receipts', () => {
    const { controller } = setup()
    controller.blockInterruptUntilThreadIsPersisted('a')
    controller.markServerListedThreads(new Set(['a']))
    controller.markThreadMessagesPersisted('a', [user])
    controller.blockInterruptUntilThreadIsPersisted('a')
    controller.markServerListedThreads(new Set(['a']))
    expect(controller.isInterruptBlocked('a')).toBe(true)
    controller.markThreadMessagesPersisted('a', [user])
    expect(controller.isInterruptBlocked('a')).toBe(false)
  })

  it('releases immediately on a recovered active turn, while an empty ID cannot release it', () => {
    const { controller } = setup()
    controller.blockInterruptUntilThreadIsPersisted('a')
    controller.maybeUnblockInterruptForActiveTurn('a', '')
    expect(controller.isInterruptBlocked('a')).toBe(true)
    controller.maybeUnblockInterruptForActiveTurn('a', 'turn')
    expect(controller.isInterruptBlocked('a')).toBe(false)
  })

  it('projects pending state for the selected conversation only', () => {
    const test = setup()
    test.controller.blockInterruptUntilThreadIsPersisted('b')
    expect(test.controller.isSelectedThreadInterruptPending.value).toBe(false)
    test.selected.value = 'b'
    expect(test.controller.isSelectedThreadInterruptPending.value).toBe(true)
    test.selected.value = ''
    expect(test.controller.isSelectedThreadInterruptPending.value).toBe(false)
  })
})

describe('activity, summary and failure projections', () => {
  it('normalizes activity and keeps only the latest three distinct details', () => {
    const test = setup()
    test.controller.setThreadInProgress('a', true)
    test.controller.setTurnActivityForThread('a', { label: ' Build  project ', details: [' Build project ', ' first ', 'second'] })
    test.controller.setTurnActivityForThread('a', { label: 'Build project', details: ['second', 'third', 'fourth'] })
    expect(test.controller.selectedLiveOverlay.value).toMatchObject({ activityLabel: 'Build project', activityDetails: ['second', 'third', 'fourth'] })
    const projection = test.controller.selectedLiveOverlay.value
    test.controller.setTurnActivityForThread('a', { label: 'Build project', details: ['second', 'third', 'fourth'] })
    expect(test.controller.selectedLiveOverlay.value).toBe(projection)
  })

  it('retains summary identity for equivalent updates and supports clearing', () => {
    const { controller } = setup()
    controller.setTurnSummaryForThread('a', { turnId: 'turn', durationMs: 1000 })
    const summary = controller.getSummary('a')
    controller.setTurnSummaryForThread('a', { turnId: 'turn', durationMs: 1000 })
    expect(controller.getSummary('a')).toBe(summary)
    controller.setTurnSummaryForThread('a', null)
    expect(controller.getSummary('a')).toBeUndefined()
  })

  it('shows default thinking, trims reasoning, and hides another conversation activity', () => {
    const test = setup()
    test.controller.setThreadInProgress('a', true)
    test.reasoning.value.a = '  working  '
    test.controller.setTurnActivityForThread('b', { label: 'Background', details: ['other'] })
    expect(test.controller.selectedLiveOverlay.value).toEqual({ activityLabel: 'Thinking', activityDetails: [], reasoningText: 'working', errorText: '' })
    test.selected.value = ''
    expect(test.controller.selectedLiveOverlay.value).toBeNull()
  })

  it('clears transient errors while preserving final failures', () => {
    const test = setup()
    test.controller.setTurnErrorForThread('a', 'temporary', { transient: true })
    test.controller.setTurnErrorForThread('b', 'final')
    test.controller.clearTransientTurnErrorForThread('b')
    test.controller.clearAllTransientTurnErrors()
    expect(test.controller.getErrorThreadIds()).toEqual(['b'])
    expect(test.controller.hasTransientError('a')).toBe(false)
    test.selected.value = 'b'
    expect(test.controller.selectedLiveOverlay.value?.errorText).toBe('final')
  })

  it('suppresses only the latest equivalent persisted failure while idle', () => {
    const test = setup()
    test.controller.setTurnErrorForThread('a', 'failure')
    test.messages.value.a = [error('older', 'failure'), error('latest', 'different')]
    expect(test.controller.selectedLiveOverlay.value?.errorText).toBe('failure')
    test.messages.value.a.push(error('current', 'failure'))
    expect(test.controller.selectedLiveOverlay.value).toBeNull()
    test.controller.setThreadInProgress('a', true)
    expect(test.controller.selectedLiveOverlay.value?.errorText).toBe('failure')
  })
})

describe('turn ordering and state cleanup', () => {
  it('owns active turns and turn order without exposing helper storage', () => {
    const test = setup()
    const lookup = { old: 2 }
    test.controller.replaceTurnIndexLookupForThread('a', lookup)
    lookup.old = 99
    expect(test.controller.turnOrder.getTurnIndex('a', 'old')).toBe(2)
    test.controller.setTurnIndexForThread('a', 'new', 4)
    test.messages.value.a = [{ ...user, turnIndex: 7 }]
    expect(test.controller.turnOrder.maxTurnIndex('a')).toBe(4)
    expect(test.controller.inferNextTurnIndex('a')).toBe(8)
    test.controller.activeTurn.setTurnId('a', 'new')
    expect(test.controller.activeTurn.getTurnId('a')).toBe('new')
    test.controller.activeTurn.clear('a')
    expect(test.controller.activeTurn.getTurnId('a')).toBeUndefined()
  })

  it('prunes only absent conversations and does not imply archive/removal for other state', () => {
    const { controller } = setup()
    for (const id of ['a', 'b']) {
      controller.setThreadInProgress(id, true)
      controller.setTurnSummaryForThread(id, { turnId: id, durationMs: 1 })
      controller.setTurnErrorForThread(id, id)
      controller.blockInterruptUntilThreadIsPersisted(id)
      controller.activeTurn.setTurnId(id, id)
      controller.setTurnIndexForThread(id, id, 0)
    }
    controller.pruneTurnOrder(new Set(['a']))
    controller.pruneTurnState(new Set(['a']))
    controller.pruneInProgress(new Set(['a']))
    expect(controller.getInProgressMap()).toEqual({ a: true })
    expect(controller.getSummary('b')).toBeUndefined()
    expect(controller.activeTurn.getTurnId('b')).toBeUndefined()
    expect(controller.turnOrder.getLookup('b')).toEqual({})
    expect(controller.getErrorThreadIds()).toEqual(['a'])
    expect(controller.isInterruptBlocked('b')).toBe(false)
    controller.removeThread('a')
    expect(controller.hasActiveInProgressThreads()).toBe(false)
    expect(controller.getSummary('a')).toBeDefined()
  })

  it('resets progress and turn state separately so the caller can preserve live reset order', () => {
    const { controller } = setup()
    controller.setThreadInProgress('a', true)
    controller.setTurnSummaryForThread('a', { turnId: 'a', durationMs: 1 })
    controller.setTurnErrorForThread('a', 'final')
    controller.blockInterruptUntilThreadIsPersisted('a')
    controller.activeTurn.setTurnId('a', 'a')
    controller.setTurnIndexForThread('a', 'a', 0)
    controller.resetProgress()
    expect(controller.hasActiveInProgressThreads()).toBe(false)
    expect(controller.captureRevisions().size).toBe(0)
    expect(controller.getSummary('a')).toBeDefined()
    controller.resetTurnState()
    expect(controller.getSummary('a')).toBeUndefined()
    expect(controller.getErrorThreadIds()).toEqual([])
    expect(controller.activeTurn.getTurnId('a')).toBeUndefined()
    expect(controller.turnOrder.getLookup('a')).toEqual({})
    expect(controller.isSelectedThreadInterruptPending.value).toBe(false)
    expect(controller.selectedLiveOverlay.value).toBeNull()
    controller.setThreadInProgress('a', true)
    expect(controller.isInProgress('a')).toBe(true)
  })
})
