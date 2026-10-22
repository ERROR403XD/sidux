import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryId } from '../delivery.js'
import { BackendQueueProcessor, createBackendQueueRuntimeFixture } from './backendQueueRuntime.js'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function fixture(nativeHistory = false) {
  const directory = await mkdtemp(join(tmpdir(), 'backend-queue-runtime-'))
  directories.push(directory)
  const { runtime, probe } = createBackendQueueRuntimeFixture()
  const processor = new BackendQueueProcessor(runtime, {
    directory,
    startRecovery: false,
    context: async () => 'fixture-account',
    ...(nativeHistory ? { features: async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }) } : {}),
  })
  return {
    processor,
    probe,
    runtime,
    message: {
      id: createDeliveryId(),
      text: 'fixture',
      imageUrls: [],
      skills: [],
      fileAttachments: [],
      collaborationMode: 'default' as const,
      model: 'fixture-model',
      effort: 'high',
    },
  }
}

describe('backend queue runtime boundary', () => {
  it('drops older-turn cursors when the native runtime stops during an identity change', async () => {
    const { processor, probe, runtime } = await fixture(true)
    const cursors: unknown[] = []
    runtime.rpc = async (_method, params) => {
      const cursor = (params as Record<string, unknown>).cursor
      if (!cursor) return { data: [], nextCursor: 'first-page' }
      cursors.push(cursor)
      return { data: [], nextCursor: cursor === 'first-page' ? 'second-page' : null }
    }
    try {
      expect(await processor.history.turnState('thread', 'old-turn')).toBeNull()
      probe.emitNotification({ method: 'codexapp/runtime/stopped', params: {} })
      expect(await processor.history.turnState('thread', 'old-turn')).toBeNull()
      expect(cursors).toEqual(['first-page', 'first-page'])
    } finally {
      await processor.dispose()
    }
  })

  it.each(['runtime transport closed', 'authentication required'])('keeps queued intent on %s and retries after a live read succeeds', async error => {
    const { processor, probe, runtime, message } = await fixture()
    const originalRpc = runtime.rpc
    const cachedSnapshot = vi.fn(() => ({ thread: { id: 'thread', status: { type: 'idle' } } }))
    runtime.getLastThreadReadSnapshot = cachedSnapshot
    runtime.rpc = async (method, params) => {
      if (method === 'thread/read') throw new Error(error)
      return originalRpc(method, params)
    }
    try {
      await processor.mutate({ protocol: 2, type: 'add', threadId: 'thread', expectedContextId: 'fixture-account', message })
      await processor.processThreadQueue('thread')
      expect(probe.rpcCalls.filter(call => call.method === 'turn/start')).toHaveLength(0)
      expect(cachedSnapshot).not.toHaveBeenCalled()
      expect((await processor.readState()).thread[0].delivery?.status).toBe('queued')
      runtime.rpc = originalRpc
      await processor.processThreadQueue('thread')
      expect(probe.rpcCalls.filter(call => call.method === 'turn/start')).toHaveLength(1)
      expect(await processor.deliveries.result(message.id)).toMatchObject({ status: 'accepted' })
    } finally {
      await processor.dispose()
    }
  })

  it('retains the explicit empty-rollout fallback for a newly created thread', async () => {
    const { processor, probe, runtime, message } = await fixture()
    const originalRpc = runtime.rpc
    runtime.getLastThreadReadSnapshot = () => ({ thread: { id: 'thread', status: { type: 'idle' } } })
    runtime.rpc = async (method, params) => {
      if (method === 'thread/read') throw new Error('failed to read thread: rollout is empty')
      return originalRpc(method, params)
    }
    try {
      await processor.mutate({ protocol: 2, type: 'add', threadId: 'thread', expectedContextId: 'fixture-account', message })
      await processor.processThreadQueue('thread')
      expect(probe.rpcCalls.filter(call => call.method === 'turn/start')).toHaveLength(1)
    } finally {
      await processor.dispose()
    }
  })

  it('initializes default delivery storage in an empty home without creating legacy state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'backend-queue-empty-home-'))
    directories.push(home)
    vi.stubEnv('CODEX_HOME', home)
    const { runtime } = createBackendQueueRuntimeFixture()
    const processor = new BackendQueueProcessor(runtime, { context: async () => 'fixture-account' })
    try {
      await expect(processor.readState()).resolves.toEqual({})
      await expect(readFile(join(home, '.codex-global-state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await processor.dispose()
    }
  })

  it.each(['invalid json', '[]', 'directory'])('preserves a legacy migration failure for %s', async raw => {
    const home = await mkdtemp(join(tmpdir(), 'backend-queue-invalid-home-'))
    directories.push(home)
    vi.stubEnv('CODEX_HOME', home)
    const statePath = join(home, '.codex-global-state.json')
    if (raw === 'directory') await mkdir(statePath)
    else await writeFile(statePath, raw)
    const { runtime } = createBackendQueueRuntimeFixture()
    const processor = new BackendQueueProcessor(runtime, { startRecovery: false, context: async () => 'fixture-account' })
    try {
      await expect(processor.readState()).rejects.toThrow()
      if (raw !== 'directory') await expect(readFile(statePath, 'utf8')).resolves.toBe(raw)
    } finally {
      await processor.dispose()
    }
  })

  it('subscribes queue state, drains on completion, and unsubscribes on dispose', async () => {
    const { processor, probe, runtime, message } = await fixture()
    expect(await probe.readQueueState()).toEqual({})
    await processor.mutate({ protocol: 2, type: 'add', threadId: 'thread', expectedContextId: 'fixture-account', message })
    await processor.dispose()
    probe.emitNotification({ method: 'turn/completed', params: { threadId: 'thread' } })
    expect(probe.rpcCalls.filter(call => call.method === 'thread/read')).toEqual([])
  })

  it('blocks queued dispatch while the same thread owns a pending server request', async () => {
    const { processor, probe, message } = await fixture()
    await processor.mutate({ protocol: 2, type: 'add', threadId: 'thread', expectedContextId: 'fixture-account', message })
    probe.setPendingRequests([{ method: 'question', params: { threadId: 'thread' } }])
    await processor.processThreadQueue('thread')
    expect(probe.rpcCalls.filter(call => call.method === 'turn/start')).toHaveLength(0)
    await processor.dispose()
  })

  it('returns the same disposal promise for repeat dispose calls', async () => {
    const { processor } = await fixture()
    const disposal = processor.dispose()
    expect(processor.dispose()).toBe(disposal)
    await disposal
  })
})
