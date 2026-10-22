import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcNotification } from '../api/codexRpcClient'
import { createThreadSubscriptionController } from './threadSubscriptionController'
import { automaticResumeStartedMethod } from '../threadAutomaticResume'

const transport = vi.hoisted(() => ({ subscribe: vi.fn(), reconnect: vi.fn() }))
vi.mock('../api/codexRpcClient', () => ({ subscribeRpcNotifications: transport.subscribe }))
vi.mock('../subtasks', () => ({ observeTaskNotification: transport.reconnect }))

function setup(notifyBrowser?: (notification: RpcNotification) => void) {
  vi.stubGlobal('window', {})
  vi.clearAllMocks()
  const calls: string[] = []
  const command = (name: string) => vi.fn((..._args: unknown[]) => { calls.push(name) })
  const read = (name: string) => vi.fn(async (..._args: unknown[]) => { calls.push(name) })
  const ports = {
    pending: { load: read('pending') },
    completion: { load: read('completion'), handleChange: command('completion-change') },
    queue: { refresh: read('queue') },
    model: { resetCatalog: command('reset-model'), refresh: read('model') },
    quota: { invalidateCache: command('invalidate-quota'), refresh: read('quota') },
    status: { clearTransientErrors: command('clear-transient') },
    realtime: { handle: command('realtime') },
    synchronization: { recover: read('recover'), queue: command('sync-queue') },
  }
  const callbacks: Array<(notification: RpcNotification) => void> = []
  const cleanups: ReturnType<typeof vi.fn>[] = []
  transport.subscribe.mockImplementation(callback => {
    calls.push('subscribe')
    callbacks.push(callback)
    const cleanup = command('close')
    cleanups.push(cleanup)
    return cleanup
  })
  const controller = createThreadSubscriptionController({ ...ports, notifyBrowser })
  const notify = (method: string, params: unknown = {}) => callbacks.at(-1)!({ method, params, atIso: '' })
  return { controller, ports, calls, callbacks, cleanups, notify }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('notification subscription ownership', () => {
  it('routes automatic resume notices only to the notification channel', () => {
    const browser = vi.fn()
    const test = setup(browser)
    test.controller.start()
    test.calls.length = 0
    const params = { threadId: 'thread', deliveryId: 'attempt', source: 'quota', turnId: 'turn' }
    test.notify(automaticResumeStartedMethod, params)
    expect(browser).toHaveBeenCalledExactlyOnceWith({ method: automaticResumeStartedMethod, params, atIso: '' })
    expect(test.calls).toEqual([])
  })
  it('does not start a stream or restoration without a window', () => {
    const test = setup()
    vi.stubGlobal('window', undefined)
    test.controller.start()
    expect(test.controller.isStarted()).toBe(false)
    expect(test.calls).toEqual([])
  })

  it('restores pending once before subscribing and does not duplicate a live stream', () => {
    const test = setup()
    test.controller.start()
    test.controller.start()
    expect(test.calls).toEqual(['pending', 'subscribe'])
    expect(test.controller.isStarted()).toBe(true)
    test.controller.invalidate()
    test.controller.close()
    expect(test.controller.isStarted()).toBe(false)
    expect(test.cleanups[0]).toHaveBeenCalledOnce()
  })

  it('routes completion changes without queue reads or general event interpretation', () => {
    const test = setup()
    test.controller.start()
    test.calls.length = 0
    const params = { threadId: 'a', token: 'token' }
    test.notify('codexapp/completions/changed', params)
    expect(test.calls).toEqual(['completion-change'])
    expect(test.ports.completion.handleChange).toHaveBeenCalledExactlyOnceWith(params)
  })

  it('routes queue changes without interpreting them as realtime or sync events', async () => {
    const test = setup()
    test.ports.queue.refresh.mockRejectedValueOnce(new Error('transient'))
    test.controller.start()
    test.calls.length = 0
    test.notify('codexapp/queue/changed')
    await Promise.resolve()
    expect(test.ports.queue.refresh).toHaveBeenCalledOnce()
    expect(test.ports.realtime.handle).not.toHaveBeenCalled()
    expect(test.ports.synchronization.queue).not.toHaveBeenCalled()
  })

  it('aligns the first connection without reconnect-only invalidation', () => {
    const test = setup()
    test.controller.start()
    test.calls.length = 0
    test.notify('ready')
    expect(test.calls).toEqual(['completion', 'clear-transient', 'queue', 'recover'])
    expect(test.ports.synchronization.recover).toHaveBeenCalledExactlyOnceWith(false)
    expect(transport.reconnect).not.toHaveBeenCalled()
  })

  it('invalidates model and quota before reconnect reads, then recovers bridge state', () => {
    const test = setup()
    test.controller.start()
    test.notify('ready')
    test.calls.length = 0
    test.notify('ready')
    expect(test.calls).toEqual(['completion', 'reset-model', 'invalidate-quota', 'model', 'quota', 'clear-transient', 'queue', 'recover'])
    expect(transport.reconnect).toHaveBeenCalledExactlyOnceWith({ method: 'codexapp/reconnected', params: {} })
    expect(test.ports.synchronization.recover.mock.calls).toEqual([[false], [true]])
  })

  it('applies a normal event before scheduling synchronization and preserves event identity', () => {
    const test = setup()
    test.controller.start()
    test.calls.length = 0
    test.notify('turn/started', { threadId: 'a', turn: { id: 'turn' } })
    expect(test.calls).toEqual(['realtime', 'sync-queue'])
    expect(test.ports.realtime.handle.mock.calls[0][0]).toBe(test.ports.synchronization.queue.mock.calls[0][0])
  })

  it.each(['ready', 'codexapp/completions/changed', 'codexapp/queue/changed', 'turn/started'])
    ('invalidates %s before transport cleanup so peer teardown cannot receive stale events', method => {
      const test = setup()
      test.controller.start()
      test.calls.length = 0
      test.controller.invalidate()
      test.notify(method)
      expect(test.calls).toEqual([])
      expect(test.controller.isStarted()).toBe(true)
      test.cleanups[0].mockImplementation(() => { test.notify(method) })
      test.controller.close()
      expect(test.calls).toEqual([])
      test.controller.close()
      expect(test.cleanups[0]).toHaveBeenCalledOnce()
      expect(test.controller.isStarted()).toBe(false)
    })

  it('resets the ready state after restart and ignores the previous subscription callback', () => {
    const test = setup()
    test.controller.start()
    test.notify('ready')
    const old = test.callbacks[0]
    test.controller.invalidate()
    test.controller.close()
    test.controller.start()
    test.calls.length = 0
    old({ method: 'ready', params: {}, atIso: '' })
    expect(test.calls).toEqual([])
    test.notify('ready')
    expect(test.calls).toEqual(['completion', 'clear-transient', 'queue', 'recover'])
    expect(transport.reconnect).not.toHaveBeenCalled()
  })

  it('releases exactly one stream per cycle and leaves all ten stopped callbacks inert', () => {
    const test = setup()
    for (let index = 0; index < 10; index += 1) {
      test.controller.start()
      test.controller.start()
      test.controller.invalidate()
      test.controller.close()
      test.controller.close()
    }
    expect(transport.subscribe).toHaveBeenCalledTimes(10)
    expect(test.cleanups.every(cleanup => cleanup.mock.calls.length === 1)).toBe(true)
    test.calls.length = 0
    for (const callback of test.callbacks) callback({ method: 'ready', params: {}, atIso: '' })
    expect(test.calls).toEqual([])
    expect(test.controller.isStarted()).toBe(false)
  })
})
