import { describe, expect, it, vi } from 'vitest'
import { createAccountDisconnectionHandler, createRuntimeActivityService } from './runtimeActivityService.js'

function fixture() {
  const dependencies = {
    methods: vi.fn(async () => ['thread/loaded/list', 'thread/backgroundTerminals/list']),
    rpc: vi.fn(async (method: string, params: unknown) => {
      if (method === 'thread/loaded/list') return { data: ['a', 'b'], nextCursor: null }
      return { data: (params as { threadId: string }).threadId === 'a' ? ['fixture terminal'] : [], nextCursor: null }
    }),
    isIdentityChanging: vi.fn(() => false),
    readQueueState: vi.fn(async () => ({ a: [{ id: 'queued' }] as never })),
  }
  return { dependencies, service: createRuntimeActivityService(dependencies) }
}

describe('shared runtime activity policy', () => {
  it('checks native capability before scanning loaded threads once with bounded background RPCs', async () => {
    const { service, dependencies } = fixture()
    expect(await service.backgroundActivity()).toEqual(['a'])
    expect(dependencies.methods).toHaveBeenCalledTimes(1)
    expect(dependencies.rpc.mock.calls).toEqual([
      ['thread/loaded/list', { limit: 100, cursor: null }],
      ['thread/backgroundTerminals/list', { threadId: 'a', limit: 1 }],
      ['thread/backgroundTerminals/list', { threadId: 'b', limit: 1 }],
    ])
    dependencies.rpc.mockClear()
    dependencies.methods.mockResolvedValue([])
    expect(await service.backgroundActivity()).toEqual([])
    expect(dependencies.rpc).not.toHaveBeenCalled()
    dependencies.methods.mockResolvedValue(['thread/backgroundTerminals/list'])
    await expect(service.backgroundActivity()).rejects.toThrow('无法完整核对后台终端')
    expect(dependencies.rpc).not.toHaveBeenCalled()
  })

  it('short-circuits compaction while identity changes and reads queue state only once otherwise', async () => {
    const { service, dependencies } = fixture()
    dependencies.isIdentityChanging.mockReturnValue(true)
    expect(await service.compactionBlocked('a')).toBe(true)
    expect(dependencies.readQueueState).not.toHaveBeenCalled()
    dependencies.isIdentityChanging.mockReturnValue(false)
    expect(await service.compactionBlocked('a')).toBe(true)
    expect(await service.compactionBlocked('b')).toBe(false)
    expect(dependencies.readQueueState).toHaveBeenCalledTimes(2)
    expect(await service.hasQueuedMessages('a')).toBe(true)
    expect(dependencies.readQueueState).toHaveBeenCalledTimes(3)
  })

  it('cancels affected automations for every disconnection and deliveries only for the primary account', async () => {
    const dependencies = { cancelAutomations: vi.fn(async () => {}), cancelAccountDeliveries: vi.fn(async () => {}) }
    const disconnected = createAccountDisconnectionHandler(dependencies)
    disconnected('storage-a', false, ['run-1'])
    expect(dependencies.cancelAutomations).toHaveBeenCalledWith('storage-a', false, ['run-1'])
    expect(dependencies.cancelAccountDeliveries).not.toHaveBeenCalled()
    dependencies.cancelAutomations.mockRejectedValueOnce(new Error('fixture cancel failed'))
    dependencies.cancelAccountDeliveries.mockRejectedValueOnce(new Error('fixture delivery cancel failed'))
    disconnected('storage-b', true, ['run-2'])
    expect(dependencies.cancelAutomations).toHaveBeenCalledTimes(2)
    expect(dependencies.cancelAccountDeliveries).toHaveBeenCalledTimes(1)
    await Promise.resolve()
  })
})
