import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeliveryId } from '../delivery.js'
import type { ThreadQueueState } from '../threadQueue.js'
import { AppServerProcess } from './appServerProcess.js'
import { BackendQueueProcessor } from './backendQueueRuntime.js'
import { readLegacyThreadQueueState } from './legacyThreadQueueStore.js'

let home: string
const processors: BackendQueueProcessor[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'queue-runtime-binding-'))
  vi.stubEnv('CODEX_HOME', home)
})

afterEach(async () => {
  await Promise.all(processors.splice(0).map(processor => processor.dispose()))
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function runtimeFixture() {
  const runtime = new AppServerProcess()
  vi.spyOn(runtime, 'rpc').mockImplementation(async method => (
    method === 'thread/read'
      ? { thread: { id: 'thread', status: { type: 'idle' } } }
      : { data: [], nextCursor: null }
  ))
  return runtime
}

function processorFixture(runtime: AppServerProcess) {
  const processor = new BackendQueueProcessor(runtime, { startRecovery: false, context: async () => 'fixture-account' })
  processors.push(processor)
  return processor
}

const message = () => ({ id: createDeliveryId(), text: 'fixture', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' as const })

describe('queue reader ownership with the real runtime and storage', () => {
  it('requires a single owner and makes release idempotent across rebinding and native restarts', async () => {
    const runtime = runtimeFixture()
    const read = async () => ({ thread: [message()] })
    const release = runtime.bindQueueStateReader(read)
    expect(() => runtime.bindQueueStateReader(read)).toThrow('已绑定')
    runtime.dispose()
    expect((await runtime.getRuntimeQuiescenceSnapshot()).queuedThreadIds).toEqual(['thread'])
    release()
    const releaseCurrent = runtime.bindQueueStateReader(read)
    release()
    expect((await runtime.getRuntimeQuiescenceSnapshot()).queuedThreadIds).toEqual(['thread'])
    releaseCurrent()
    expect((await runtime.getRuntimeQuiescenceSnapshot()).idle).toBe(true)
  })

  it('rejects an in-flight idle snapshot when its reader owner changes', async () => {
    const runtime = runtimeFixture()
    let resolveRead!: (state: ThreadQueueState) => void
    let readStarted!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    const release = runtime.bindQueueStateReader(() => {
      readStarted()
      return new Promise(resolve => { resolveRead = resolve })
    })
    const snapshot = runtime.getRuntimeQuiescenceSnapshot()
    await started
    release()
    const releaseCurrent = runtime.bindQueueStateReader(async () => ({ thread: [message()] }))
    resolveRead({})
    await expect(snapshot).rejects.toThrow('状态已变化')
    expect((await runtime.getRuntimeQuiescenceSnapshot()).idle).toBe(false)
    releaseCurrent()
  })

  it('migrates legacy rows once and preserves the same durable queue over ten processor lifecycles', async () => {
    const queued = message()
    const statePath = join(home, '.codex-global-state.json')
    await writeFile(statePath, JSON.stringify({ 'thread-queue-state': { thread: [queued] }, 'saved-workspace-roots': ['/fixture'] }))
    const runtime = runtimeFixture()
    expect((await runtime.getRuntimeQuiescenceSnapshot()).queuedThreadIds).toEqual(['thread'])
    for (let cycle = 0; cycle < 10; cycle++) {
      const processor = processorFixture(runtime)
      expect((await runtime.getRuntimeQuiescenceSnapshot()).queuedThreadIds).toEqual(['thread'])
      expect((await processor.readState()).thread).toHaveLength(1)
      expect((await processor.readState()).thread[0].id).toBe(queued.id)
      const disposal = processor.dispose()
      expect(processor.dispose()).toBe(disposal)
      await disposal
      expect((await runtime.getRuntimeQuiescenceSnapshot()).idle).toBe(true)
    }
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ 'saved-workspace-roots': ['/fixture'] })
    expect(await readLegacyThreadQueueState()).toEqual({})
  })

  it('retains queue visibility until an in-flight delivery settles during disposal', async () => {
    const runtime = runtimeFixture()
    const processor = processorFixture(runtime)
    let completeTurn!: (result: unknown) => void
    let turnStarted!: () => void
    const started = new Promise<void>(resolve => { turnStarted = resolve })
    const originalRpc = vi.mocked(runtime.rpc).getMockImplementation()!
    vi.spyOn(runtime, 'rpc').mockImplementation((method, params) => {
      if (method !== 'turn/start') return originalRpc(method, params)
      turnStarted()
      return new Promise(resolve => { completeTurn = resolve })
    })
    const submission = processor.submit({ protocol: 2, threadId: 'thread', message: message(), params: { threadId: 'thread', input: [] }, expectedContextId: 'fixture-account' })
    await started
    const disposal = processor.dispose()
    expect(() => runtime.bindQueueStateReader(async () => ({}))).toThrow('已绑定')
    expect((await runtime.getRuntimeQuiescenceSnapshot()).queuedThreadIds).toEqual(['thread'])
    completeTurn({ turn: { id: 'native-turn' } })
    await expect(submission).resolves.toMatchObject({ status: 'accepted' })
    await disposal
    const release = runtime.bindQueueStateReader(async () => ({}))
    expect((await runtime.getRuntimeQuiescenceSnapshot()).idle).toBe(true)
    release()
  })

  it('keeps isolated workers independent of the home legacy queue', async () => {
    await writeFile(join(home, '.codex-global-state.json'), JSON.stringify({ 'thread-queue-state': { thread: [message()] } }))
    const runtime = new AppServerProcess({ isolatedTask: true })
    vi.spyOn(runtime, 'rpc').mockResolvedValue({ data: [], nextCursor: null })
    expect((await runtime.getRuntimeQuiescenceSnapshot()).queuedThreadIds).toEqual([])
  })
})
