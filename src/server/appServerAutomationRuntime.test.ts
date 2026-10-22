import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppServerAutomationRuntime } from './appServerAutomationRuntime.js'
import { getVirtualProjectStore } from './workspaceStateService.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'
import { isCustomConnectionBusy } from './customConnectionService.js'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => home,
}))

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-automation-adapter-'))
  vi.stubEnv('CODEX_HOME', join(home, 'codex-home'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function fixture() {
  type Port = Parameters<typeof createAppServerAutomationRuntime>[0]
  const port = {
    automationRpc: vi.fn<Port['automationRpc']>(async method => method === 'thread/start' ? { thread: { id: 'a' } } : {}),
    beginTaskPreparation: vi.fn<Port['beginTaskPreparation']>(),
    endTaskPreparation: vi.fn<Port['endTaskPreparation']>(),
    acquireTaskAccount: vi.fn<Port['acquireTaskAccount']>(),
    releaseTaskAccount: vi.fn<Port['releaseTaskAccount']>(),
    taskAccountStorageId: vi.fn<Port['taskAccountStorageId']>(() => 'storage-a'),
    listPendingServerRequests: vi.fn<Port['listPendingServerRequests']>(() => []),
  }
  const history = { page: vi.fn<Parameters<typeof createAppServerAutomationRuntime>[1]['page']>(async () => ({ result: { thread: { turns: [{ id: 'turn-1', status: 'completed' }] } }, nextCursor: null, hasMoreOlder: false, source: 'native' })) }
  const hasQueuedMessages = vi.fn(async () => false)
  return { port, history, hasQueuedMessages, runtime: createAppServerAutomationRuntime(port, history, hasQueuedMessages) }
}

describe('app-server automation complete adapter operations', () => {
  it('uses the actual execution registry to distinguish a busy connection from another idle connection', () => {
    const registry = getAccountAuthCoordinator().executions
    const busy = registry.register({ storageId: 'storage-busy', kind: 'api', ownerId: 'fixture-busy', busy: true, disconnect: () => {} })
    const idle = registry.register({ storageId: 'storage-idle', kind: 'api', ownerId: 'fixture-idle', busy: false, disconnect: () => {} })
    try {
      expect(isCustomConnectionBusy('storage-busy')).toBe(true)
      expect(isCustomConnectionBusy('storage-idle')).toBe(false)
      expect(isCustomConnectionBusy('missing')).toBe(false)
    } finally {
      busy.release()
      idle.release()
    }
    expect(isCustomConnectionBusy('storage-busy')).toBe(false)
  })

  it('creates a real virtual-project conversation directory and uses it for native thread creation', async () => {
    const { runtime, port } = fixture()
    const project = await getVirtualProjectStore().save(undefined, 'Fixture project')
    expect(await runtime.createThread(project.id, 'Fixture automation', {}, 'run-1')).toEqual({ threadId: 'a', model: undefined })
    const cwd = (await getVirtualProjectStore().get(project.id)).cwds[0]!
    expect((await stat(cwd)).isDirectory()).toBe(true)
    expect(port.automationRpc.mock.calls).toEqual([
      ['thread/start', { cwd }, 'run-1', undefined],
      ['thread/name/set', { threadId: 'a', name: 'Fixture automation' }, 'run-1', undefined],
    ])
    const real = join(home, 'real')
    await mkdir(real)
    await runtime.createThread(real, 'Real fixture', {}, 'run-2')
    expect(port.automationRpc).toHaveBeenCalledWith('thread/start', { cwd: real }, 'run-2', undefined)
    expect((await getVirtualProjectStore().get(project.id)).cwds).toEqual([cwd])
  })

  it('builds existing text parameters and applies settings without a native preparation RPC', async () => {
    const { runtime, port } = fixture()
    expect(await runtime.prepare('a', 'Fixture prompt', 'run-1', {})).toEqual({ threadId: 'a', input: [{ type: 'text', text: 'Fixture prompt' }], clientUserMessageId: 'run-1' })
    expect(await runtime.prepare('a', 'Fixture prompt', 'run-2', { model: 'fixture-model', reasoningEffort: 'high', serviceTier: 'fast' })).toEqual({ threadId: 'a', input: [{ type: 'text', text: 'Fixture prompt' }], model: 'fixture-model', effort: 'high', serviceTier: 'fast', clientUserMessageId: 'run-2' })
    expect(port.automationRpc).not.toHaveBeenCalled()
    expect(runtime.accountBusy()).toBe(false)
    expect(runtime.accountStorageId?.('run-1')).toBe('storage-a')
  })

  it('keeps queue admission before native reads and inspects the same bounded history page', async () => {
    const { runtime, port, history, hasQueuedMessages } = fixture()
    hasQueuedMessages.mockResolvedValueOnce(true)
    expect(await runtime.canStart('a')).toBe(false)
    expect(port.automationRpc).not.toHaveBeenCalled()
    port.automationRpc.mockResolvedValue({ thread: { status: { type: 'idle' } } })
    expect(await runtime.canStart('a')).toBe(true)
    expect(port.automationRpc).toHaveBeenCalledTimes(1)
    expect(await runtime.inspect({ threadId: 'a', turnId: 'turn-1' } as never)).toEqual({ status: 'completed', turnId: 'turn-1' })
    expect(history.page).toHaveBeenCalledWith('a', { limit: 50 })
  })
})
