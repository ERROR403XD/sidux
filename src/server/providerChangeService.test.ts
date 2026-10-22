import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryId } from '../delivery.js'
import { AppServerProcess } from './appServerProcess.js'
import { BackendQueueProcessor, createBackendQueueRuntimeFixture } from './backendQueueRuntime.js'
import { createCustomConnectionService } from './customConnectionService.js'
import { CustomConnectionStore } from './customConnectionStore.js'
import { createFreeModeService } from './freeModeService.js'

let home: string
const processors: BackendQueueProcessor[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'provider-change-service-'))
  vi.stubEnv('CODEX_HOME', home)
})

afterEach(async () => {
  await Promise.all(processors.splice(0).map(processor => processor.dispose()))
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function freeModeFixture() {
  const runtime = new AppServerProcess()
  vi.spyOn(runtime, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
  const processor = new BackendQueueProcessor(runtime, { startRecovery: false, context: async () => 'fixture-account' })
  processors.push(processor)
  const service = createFreeModeService({
    appServer: runtime, backendQueueProcessor: processor,
    getRandomFreeKey: () => 'fixture', getFreeKeyCount: () => 1,
    getFreeModels: async () => ['openrouter/free'], getCachedFreeModels: () => ['openrouter/free'],
    refreshFreeModelsInBackground: () => {}, fetchOpenCodeZenModelIds: async () => ['big-pickle'],
    sortOpenCodeZenModelIds: ids => ids, filterOpenCodeZenModelsForAuthState: ids => ids,
    fetchCustomEndpointDefaultModel: async () => 'fixture', shouldMarkOpenRouterKeyAsCustom: () => true,
  })
  return { runtime, processor, service }
}

async function connectionFixture() {
  const { runtime } = createBackendQueueRuntimeFixture()
  const processor = new BackendQueueProcessor(runtime, { startRecovery: false, context: async () => 'fixture-account' })
  processors.push(processor)
  const connections = new CustomConnectionStore(home, async input => new Response(JSON.stringify(String(input).endsWith('/models') ? { data: [{ id: 'fixture' }] } : { output: [{ type: 'message' }], choices: [{ message: { content: 'fixture' } }] })))
  const draft = { alias: 'fixture', provider: 'custom', baseUrl: 'https://fixture.test/v1', apiKey: 'fixture', model: 'fixture', wireApi: 'responses' as const }
  await connections.save(draft, (await connections.test(draft)).token)
  const id = connections.snapshot().connections[0]!.storageId
  await connections.select(id)
  const isConnectionBusy = vi.fn(() => false)
  const service = createCustomConnectionService({ connections: () => connections, runProviderChange: change => processor.runProviderChange(change), isConnectionBusy })
  return { processor, connections, service, id, draft, isConnectionBusy }
}

describe('provider changes retain their resource owner through the whole operation', () => {
  it('checks real queue quiescence before reading input or changing config and then releases admission', async () => {
    const { service, processor } = freeModeFixture()
    const id = createDeliveryId()
    await processor.deliveries.submit({ threadId: 'thread', mode: 'queue', expectedContextId: 'fixture-account', message: { id, text: 'fixture', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' } })
    const input = vi.fn(async () => ({ enable: false }))
    expect((await service.change('toggle', input))?.statusCode).toBe(409)
    expect(input).not.toHaveBeenCalled()
    expect(processor.isIdentityChanging()).toBe(false)
    await expect(readFile(join(home, 'webui-custom-providers.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await processor.store.remove(id, 1)
    expect((await service.change('toggle', input))?.statusCode).toBe(200)
    expect((await service.change('toggle', input))?.statusCode).toBe(200)
    expect(processor.isIdentityChanging()).toBe(false)
  })

  it('releases admission after a native read failure, invalid body, or failed config write', async () => {
    const { service, processor, runtime } = freeModeFixture()
    vi.mocked(runtime.rpc).mockRejectedValueOnce(new Error('native unavailable'))
    await expect(service.change('toggle', async () => ({}))).rejects.toThrow('native unavailable')
    expect(processor.isIdentityChanging()).toBe(false)
    expect((await service.change('toggle', async () => { throw new Error('invalid input') }))?.statusCode).toBe(500)
    expect(processor.isIdentityChanging()).toBe(false)
    const path = join(home, 'webui-custom-providers.json')
    await mkdir(path)
    expect((await service.change('toggle', async () => ({ enable: false })))?.statusCode).toBe(500)
    expect(processor.isIdentityChanging()).toBe(false)
    await rm(path, { recursive: true })
    expect((await service.change('toggle', async () => ({ enable: false })))?.statusCode).toBe(200)
  })

  it('restores the selected connection on rejected account switches and thrown errors', async () => {
    const { service, connections, id, processor } = await connectionFixture()
    const reject = vi.fn(async () => {
      expect(connections.active()).toBeUndefined()
      expect(processor.isIdentityChanging()).toBe(true)
      return false
    })
    await service.switchToAccount(reject)
    expect(connections.active()?.storageId).toBe(id)
    expect(processor.isIdentityChanging()).toBe(false)
    await expect(service.switchToAccount(async () => { throw new Error('switch failed') })).rejects.toThrow('switch failed')
    expect(connections.active()?.storageId).toBe(id)
    expect(processor.isIdentityChanging()).toBe(false)
    await service.switchToAccount(async () => true)
    expect(connections.active()).toBeUndefined()
    expect(processor.isIdentityChanging()).toBe(false)
  })

  it('releases admission after busy connection edits/removals and permits a later selection', async () => {
    const { service, connections, id, processor, isConnectionBusy } = await connectionFixture()
    const before = connections.snapshot()
    isConnectionBusy.mockReturnValue(true)
    await expect(service.mutate('remove', { storageId: id })).rejects.toThrow('正在使用')
    await expect(service.mutate('save', { storageId: id })).rejects.toThrow('正在使用')
    expect(connections.snapshot()).toEqual(before)
    expect(processor.isIdentityChanging()).toBe(false)
    isConnectionBusy.mockReturnValue(false)
    await service.mutate('select', { storageId: id })
    expect(connections.active()?.storageId).toBe(id)
  })

  it('rejects concurrent identity changes while allowing a new saved configuration', async () => {
    const { service, connections, id, processor, draft } = await connectionFixture()
    let finish!: () => void
    const change = processor.runProviderChange(() => new Promise<void>(resolve => { finish = resolve }))
    try {
      const tested = await service.mutate('test', draft)
      expect('token' in tested).toBe(true)
      if (!('token' in tested)) throw new Error('Missing fixture test proof')
      await service.mutate('create', { ...draft, testToken: tested.token })
      expect(connections.snapshot().connections).toHaveLength(2)
      expect(connections.active()?.storageId).toBe(id)
      await expect(service.mutate('select', { storageId: id })).rejects.toThrow('正在切换')
    } finally {
      finish()
      await change
    }
    expect(processor.isIdentityChanging()).toBe(false)
    await service.mutate('select', { storageId: id })
  })
})
