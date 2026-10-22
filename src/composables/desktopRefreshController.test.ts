import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopRefreshController } from './desktopRefreshController'
import { CODEX_CLI_MISSING_MESSAGE } from '../api/codexErrors'

const api = vi.hoisted(() => ({ invalidateResume: vi.fn() }))
vi.mock('../api/threadReadGateway', () => ({ invalidateThreadResumeCache: api.invalidateResume }))
function deferred() {
  let resolve!: () => void
  let reject!: (cause: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function setup() {
  const events: string[] = []
  const state = { selectedId: 'a', error: 'Previous', cliError: 'Previous' }
  const action = (name: string) => vi.fn(() => { events.push(name) })
  const invalidation = (name: string) => ({ invalidateForAccountChange: action(name) })
  const ports = {
    getSelectedThreadId: () => state.selectedId,
    getErrorThreadIds: () => ['old-error'],
    setPageError: vi.fn((message: string) => { state.error = message }),
    setCliMissingError: vi.fn((message: string) => { state.cliError = message }),
    metadata: {
      ...invalidation('metadata'), invalidateQuotaCache: action('quota'),
      refresh: vi.fn().mockResolvedValue(undefined), scheduleRefresh: vi.fn(),
    },
    send: invalidation('send'), pending: invalidation('pending'), synchronization: invalidation('sync'),
    queue: { ...invalidation('queue'), loadPersistedStateIfNeeded: vi.fn().mockResolvedValue(undefined) },
    completion: { resetAcknowledgements: action('completion') },
    mutation: invalidation('mutation'),
    model: { ...invalidation('model'), invalidateCatalog: action('catalog') },
    list: { resetForAccountChange: action('list'), load: vi.fn().mockResolvedValue(undefined) },
    history: { invalidateForAccountChange: vi.fn(() => { events.push('history') }), load: vi.fn().mockResolvedValue(undefined) },
  }
  api.invalidateResume.mockImplementation(() => { events.push('resume') })
  const owner = createDesktopRefreshController(ports)
  return { owner, ports, state, events }
}
beforeEach(() => { vi.clearAllMocks() })

describe('complete desktop refresh coordination', () => {
  it('invalidates account peers synchronously in the original order before queue preparation', async () => {
    const { owner, ports, events } = setup()
    ports.metadata.invalidateForAccountChange.mockImplementation(() => { events.push(`metadata:${owner.getAccountRevision()}`) })
    const waiting = deferred()
    ports.queue.loadPersistedStateIfNeeded.mockReturnValueOnce(waiting.promise)
    const refresh = owner.refreshAll({ accountChanged: true })
    expect(owner.getAccountRevision()).toBe(1)
    expect(events).toEqual(['metadata:1', 'send', 'pending', 'sync', 'queue', 'completion', 'mutation', 'model', 'list', 'resume', 'catalog', 'quota', 'history'])
    expect(ports.history.invalidateForAccountChange).toHaveBeenCalledExactlyOnceWith(['old-error', 'a'])
    expect(ports.list.load).not.toHaveBeenCalled()
    waiting.resolve()
    await refresh
    expect(ports.list.load).toHaveBeenCalledExactlyOnceWith({ force: false })
    expect(ports.history.load).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('invalidates only catalog and quota when the provider changes', async () => {
    const { owner, ports, events } = setup()
    await owner.refreshAll({ providerChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    expect(owner.getAccountRevision()).toBe(0)
    expect(events).toEqual(['catalog', 'quota'])
    expect(api.invalidateResume).not.toHaveBeenCalled()
    expect(ports.metadata.scheduleRefresh).toHaveBeenCalledExactlyOnceWith({ providerChanged: true, includeProviderModels: false })
  })

  it('preserves both account and provider invalidation when both flags are true', async () => {
    const { owner, ports } = setup()
    await owner.refreshAll({ accountChanged: true, providerChanged: true, includeThreads: false, includeSelectedThreadMessages: false })
    expect(owner.getAccountRevision()).toBe(1)
    expect(ports.model.invalidateCatalog).toHaveBeenCalledTimes(2)
    expect(ports.metadata.invalidateQuotaCache).toHaveBeenCalledTimes(2)
  })

  it.each(['queue', 'list', 'history', 'ancillary'] as const)('rejects stale %s continuations and errors after read invalidation', async phase => {
    const { owner, ports, state } = setup()
    const waiting = deferred()
    const action = { queue: ports.queue.loadPersistedStateIfNeeded, list: ports.list.load, history: ports.history.load, ancillary: ports.metadata.refresh }[phase]
    action.mockReturnValueOnce(waiting.promise)
    const refresh = owner.refreshAll({ awaitAncillaryRefreshes: phase === 'ancillary' })
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    expect(action).toHaveBeenCalledOnce()
    owner.invalidateReads()
    state.error = 'Current error'
    state.cliError = 'Current CLI error'
    waiting.reject(new Error('Stale error'))
    await refresh
    expect(state.error).toBe('Current error')
    expect(state.cliError).toBe('Current CLI error')
    expect(ports.metadata.scheduleRefresh).not.toHaveBeenCalled()
    if (phase === 'queue') expect(ports.list.load).not.toHaveBeenCalled()
    if (phase === 'list') expect(ports.history.load).not.toHaveBeenCalled()
  })

  it('preserves explicit refresh after read invalidation and current selection at history admission', async () => {
    const { owner, ports, state } = setup()
    owner.invalidateReads()
    const waiting = deferred()
    ports.queue.loadPersistedStateIfNeeded.mockReturnValueOnce(waiting.promise)
    const refresh = owner.refreshAll({ forceThreadRefresh: true })
    state.selectedId = 'b'
    waiting.resolve()
    await refresh
    expect(ports.list.load).toHaveBeenCalledExactlyOnceWith({ force: true })
    expect(ports.history.load).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('awaits ancillary refresh when requested and otherwise schedules it without joining', async () => {
    const { owner, ports } = setup()
    const waiting = deferred()
    ports.metadata.refresh.mockReturnValueOnce(waiting.promise)
    let settled = false
    const refresh = owner.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false, awaitAncillaryRefreshes: true }).then(() => { settled = true })
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
    expect(settled).toBe(false)
    expect(ports.metadata.refresh).toHaveBeenCalledExactlyOnceWith({ providerChanged: undefined, includeProviderModels: true })
    waiting.resolve()
    await refresh
    expect(settled).toBe(true)
    await owner.refreshAll({ includeThreads: false, includeSelectedThreadMessages: false })
    expect(ports.metadata.scheduleRefresh).toHaveBeenCalledExactlyOnceWith({ providerChanged: undefined, includeProviderModels: false })
  })

  it('shows current history errors while still scheduling ancillary work', async () => {
    const { owner, ports, state } = setup()
    ports.history.load.mockRejectedValueOnce(new Error('History failed'))
    await owner.refreshAll()
    expect(state.error).toBe('History failed')
    expect(state.cliError).toBe('')
    expect(ports.metadata.scheduleRefresh).toHaveBeenCalledOnce()
  })

  it('classifies a current missing CLI and clears a prior CLI error for other failures', async () => {
    const { owner, ports, state } = setup()
    ports.list.load.mockRejectedValueOnce(new Error('Codex CLI is not available'))
    await owner.refreshAll()
    expect(state.cliError).toBe(CODEX_CLI_MISSING_MESSAGE)
    ports.list.load.mockRejectedValueOnce(new Error('Other failure'))
    await owner.refreshAll()
    expect(state.cliError).toBe('')
    expect(state.error).toBe('Other failure')
  })
})
