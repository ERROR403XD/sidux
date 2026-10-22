import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createThreadCompletionController } from './threadCompletionController'

const request = vi.fn()
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const response = (data: Record<string, unknown> = {}) => ({ ok: true, json: vi.fn().mockResolvedValue({ data }) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setup(visible = false, routeVisible = false) {
  vi.stubGlobal('fetch', request)
  vi.stubGlobal('document', { visibilityState: visible ? 'visible' : 'hidden' })
  const onChanged = vi.fn()
  const controller = createThreadCompletionController({ getSelectedThreadId: () => 'viewed', isThreadVisible: () => routeVisible, onChanged })
  return {
    controller, onChanged,
    complete: (token: string | null, threadId = 'viewed') => controller.handleCompletionChange({ threadId, token }),
  }
}
beforeEach(() => { request.mockReset().mockResolvedValue(response()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('completion snapshot, live merge and acknowledgement owner', () => {
  it('does not count green completions as unread but clears them with the same read command', async () => {
    const test = setup()
    test.controller.handleCompletionChange({ threadId: 'auto', token: 'run', kind: 'background' })
    expect(test.controller.getUnreadToken('auto')).toBeUndefined()
    expect(test.controller.isBackgroundCompleted('auto')).toBe(true)
    test.controller.markThreadAsRead('auto')
    await flush()
    expect(test.controller.isBackgroundCompleted('auto')).toBe(false)
    expect(request).toHaveBeenCalledWith('/codex-api/thread-completions', expect.objectContaining({ body: JSON.stringify({ threadId: 'auto', token: 'run' }) }))
  })
  it('joins an active snapshot, filters non-string entries, and refreshes on the next nonconcurrent load', async () => {
    const test = setup()
    const pending = deferred<ReturnType<typeof response>>()
    request.mockReturnValueOnce(pending.promise)
    const first = test.controller.loadCompletionList()
    expect(test.controller.loadCompletionList()).toBe(first)
    pending.resolve(response({ background: 'token', invalid: null, numeric: 1 }))
    await first
    expect(test.controller.getUnreadToken('background')).toBe('token')
    expect(test.controller.getUnreadToken('invalid')).toBeUndefined()
    expect(test.controller.getUnreadToken('numeric')).toBeUndefined()
    await test.controller.loadCompletionList()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each(['http', 'network'])('preserves live markers on a snapshot %s failure and permits the next read', async failure => {
    const test = setup()
    test.complete('live')
    if (failure === 'http') request.mockResolvedValueOnce({ ok: false })
    else request.mockRejectedValueOnce(new Error('offline'))
    await test.controller.loadCompletionList()
    expect(test.controller.getUnreadToken('viewed')).toBe('live')
    request.mockResolvedValueOnce(response({ background: 'current' }))
    await test.controller.loadCompletionList()
    expect(test.controller.getUnreadToken('background')).toBe('current')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('makes no IO or live changes through stopped commands, and starts a fresh lifecycle', async () => {
    const test = setup(true, true)
    test.controller.stop()
    test.complete('stopped')
    test.controller.markThreadAsRead('viewed')
    await test.controller.loadCompletionList()
    expect(request).not.toHaveBeenCalled()
    expect(test.onChanged).not.toHaveBeenCalled()
    test.controller.start()
    test.complete('current')
    await flush()
    expect(request).toHaveBeenCalledExactlyOnceWith('/codex-api/thread-completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: 'viewed', token: 'current' }) })
    expect(test.controller.getUnreadToken('viewed')).toBeUndefined()
  })

  it('does not parse a stopped response or let its finally release the current read slot', async () => {
    const test = setup()
    const old = deferred<ReturnType<typeof response>>()
    const current = deferred<ReturnType<typeof response>>()
    request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const oldRead = test.controller.loadCompletionList()
    test.controller.stop()
    test.controller.start()
    const currentRead = test.controller.loadCompletionList()
    const staleResponse = response({ viewed: 'stale' })
    old.resolve(staleResponse)
    await oldRead
    expect(staleResponse.json).not.toHaveBeenCalled()
    expect(test.controller.loadCompletionList()).toBe(currentRead)
    current.resolve(response({ viewed: 'current' }))
    await currentRead
    expect(test.controller.getUnreadToken('viewed')).toBe('current')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('buffers a successful acknowledgement as a deletion over a pending snapshot', async () => {
    const test = setup()
    test.complete('live')
    const pending = deferred<ReturnType<typeof response>>()
    request.mockReturnValueOnce(pending.promise)
    const reading = test.controller.loadCompletionList()
    test.controller.markThreadAsRead('viewed')
    await flush()
    expect(test.controller.getUnreadToken('viewed')).toBeUndefined()
    pending.resolve(response({ viewed: 'live', background: 'unseen' }))
    await reading
    expect(test.controller.getUnreadToken('viewed')).toBeUndefined()
    expect(test.controller.getUnreadToken('background')).toBe('unseen')
  })

  it('deduplicates a pending acknowledgement, preserves a newer token and keeps the newer request busy', async () => {
    const test = setup()
    const old = deferred<{ ok: boolean }>()
    const current = deferred<{ ok: boolean }>()
    request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    test.complete('old')
    test.controller.markThreadAsRead('viewed')
    test.controller.markThreadAsRead('viewed')
    test.complete('current')
    test.controller.markThreadAsRead('viewed')
    old.resolve({ ok: true })
    await flush()
    test.controller.markThreadAsRead('viewed')
    expect(request).toHaveBeenCalledTimes(2)
    expect(test.controller.getUnreadToken('viewed')).toBe('current')
    current.resolve({ ok: true })
    await flush()
    expect(test.controller.getUnreadToken('viewed')).toBeUndefined()
  })

  it.each(['http', 'network'])('keeps a token after acknowledgement %s failure and retries it once requested', async failure => {
    const test = setup()
    if (failure === 'http') request.mockResolvedValueOnce({ ok: false })
    else request.mockRejectedValueOnce(new Error('offline'))
    test.complete('retry')
    test.controller.markThreadAsRead('viewed')
    await flush()
    expect(test.controller.getUnreadToken('viewed')).toBe('retry')
    test.controller.markThreadAsRead('viewed')
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(test.controller.getUnreadToken('viewed')).toBeUndefined()
  })

  it.each(['account', 'stop'])('rejects an old acknowledgement and keeps current deduplication after %s', async transition => {
    const test = setup()
    const old = deferred<{ ok: boolean }>()
    const current = deferred<{ ok: boolean }>()
    request.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    test.complete('same')
    test.controller.markThreadAsRead('viewed')
    if (transition === 'account') test.controller.resetCompletionAcknowledgements()
    else { test.controller.stop(); test.controller.start(); test.complete('same') }
    test.controller.markThreadAsRead('viewed')
    old.resolve({ ok: true })
    await flush()
    test.controller.markThreadAsRead('viewed')
    expect(request).toHaveBeenCalledTimes(2)
    expect(test.controller.getUnreadToken('viewed')).toBe('same')
    current.resolve({ ok: true })
    await flush()
    expect(test.controller.getUnreadToken('viewed')).toBeUndefined()
  })

  it.each([[true, true, 'viewed', 1], [false, true, 'viewed', 0], [true, false, 'viewed', 0], [true, true, 'background', 0]] as const)
    ('auto-acknowledges with page visible=%s route visible=%s thread=%s only when eligible', async (visible, routeVisible, threadId, expected) => {
      const test = setup(visible, routeVisible)
      test.complete('token', threadId)
      await flush()
      expect(request).toHaveBeenCalledTimes(expected)
    })

  it('preserves the global snapshot and live tokens when only account acknowledgement dedup resets', async () => {
    const test = setup()
    const pending = deferred<ReturnType<typeof response>>()
    request.mockReturnValueOnce(pending.promise)
    const reading = test.controller.loadCompletionList()
    test.complete('live', 'background')
    test.controller.resetCompletionAcknowledgements()
    expect(test.controller.loadCompletionList()).toBe(reading)
    pending.resolve(response({ background: 'older', elsewhere: 'global' }))
    await reading
    expect(test.controller.getUnreadToken('background')).toBe('live')
    expect(test.controller.getUnreadToken('elsewhere')).toBe('global')
    expect(request).toHaveBeenCalledOnce()
  })

  it('bounds acknowledgement replay memory at 500 while retaining recent tokens', async () => {
    const test = setup()
    for (let i = 0; i < 505; i++) {
      test.complete(`token-${i}`)
      test.controller.markThreadAsRead('viewed')
      await flush()
    }
    test.complete('token-504')
    test.controller.markThreadAsRead('viewed')
    expect(request).toHaveBeenCalledTimes(505)
    test.complete('token-0')
    test.controller.markThreadAsRead('viewed')
    await flush()
    expect(request).toHaveBeenCalledTimes(506)
  })

  it('ignores ten stopped reads and keeps only the final lifecycle snapshot', async () => {
    const test = setup()
    const pending = Array.from({ length: 10 }, () => deferred<ReturnType<typeof response>>())
    const reads: Promise<void>[] = []
    for (const old of pending) {
      request.mockReturnValueOnce(old.promise)
      reads.push(test.controller.loadCompletionList())
      test.controller.stop()
      test.controller.start()
    }
    await test.controller.loadCompletionList()
    for (const old of pending) old.resolve(response({ viewed: 'old' }))
    await Promise.all(reads)
    expect(request).toHaveBeenCalledTimes(11)
    expect(test.controller.getUnreadToken('viewed')).toBeUndefined()
    expect(test.onChanged).toHaveBeenCalledOnce()
  })

  it('ignores invalid notifications and keeps mutable maps, deduplication and request slots private', () => {
    const test = setup(true, true)
    test.controller.handleCompletionChange(null)
    test.controller.handleCompletionChange({ token: 'invalid' })
    expect(request).not.toHaveBeenCalled()
    expect(test.onChanged).not.toHaveBeenCalled()
    for (const name of ['eventUnreadByThreadId', 'completionChangesDuringLoad', 'completionLoad', 'inFlightCompletionAcknowledgements', 'acknowledgedCompletionTokens', 'completionAcknowledgementGeneration']) expect(test.controller).not.toHaveProperty(name)
  })
})
