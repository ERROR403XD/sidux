import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IgnoredQuotaErrors } from './ignoredQuotaErrors.js'
import { createPreferencesService } from './preferencesService.js'
import { ThreadInterruptionList } from './threadInterruptionList.js'
import { createThreadQueryService } from './threadQueryService.js'
import { queueWorkspaceRootsMutation } from './workspaceStateService.js'

type Notification = { method: string; params: unknown }
let home: string
const resources: ReturnType<typeof createThreadQueryService>[] = []

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-thread-query-'))
  vi.stubEnv('CODEX_HOME', home)
})
afterEach(async () => {
  for (const resource of resources.splice(0)) resource.dispose()
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function fixture() {
  const listeners = new Set<(notification: Notification) => void>()
  const released: number[] = []
  const ignoredErrors = new IgnoredQuotaErrors(home)
  const interruptions = new ThreadInterruptionList(home, ignoredErrors)
  const runtime = {
    rpc: vi.fn<Parameters<typeof createThreadQueryService>[0]['rpc']>(),
    onNotification: vi.fn((listener: (notification: Notification) => void) => {
      const index = listeners.size
      listeners.add(listener)
      return () => { released.push(index); listeners.delete(listener) }
    }),
    getStreamEvents: vi.fn(() => [{ method: 'error', params: { turnId: 'turn-1', error: { message: 'quota exceeded' }, willRetry: false }, atIso: '2026-10-11T12:00:00Z' }]),
    ignoredErrors,
    interruptions,
  }
  const service = createThreadQueryService(runtime, async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }))
  resources.push(service)
  return { service, runtime, listeners, released, emit: (notification: Notification) => { for (const listener of listeners) listener(notification) } }
}

describe('thread query resource ownership and complete read operations', () => {
  it('registers only two subscribers and releases them in the original order over ten lifecycles', () => {
    for (let index = 0; index < 10; index++) {
      const { service, runtime, listeners, released } = fixture()
      const invalidation = vi.spyOn(service.search, 'invalidate')
      const clear = vi.spyOn(service.history, 'clear')
      expect(listeners.size).toBe(2)
      expect(runtime.rpc).not.toHaveBeenCalled()
      service.dispose()
      service.dispose()
      expect(listeners.size).toBe(0)
      expect(released).toEqual([1, 0])
      expect(invalidation).toHaveBeenCalledTimes(1)
      expect(clear).toHaveBeenCalledTimes(1)
      expect(invalidation.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]!)
    }
  })

  it('invalidates history/sidebar/search by the original method and thread id rules', () => {
    const { service, emit } = fixture()
    const history = vi.spyOn(service.history, 'invalidate')
    const sidebar = vi.spyOn(service.sidebarThreadStatus, 'invalidate')
    const search = vi.spyOn(service.search, 'invalidate')
    emit({ method: 'thread/quotaErrorIgnored/changed', params: { threadId: 'a' } })
    expect(sidebar).toHaveBeenCalledWith('a')
    expect(history).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    emit({ method: 'turn/started', params: { thread_id: 'b' } })
    expect(history).toHaveBeenCalledWith('b')
    expect(sidebar).toHaveBeenLastCalledWith('b')
    expect(search).toHaveBeenCalledWith('b')
    emit({ method: 'item/completed', params: { thread: { id: 'c' } } })
    expect(history).toHaveBeenLastCalledWith('c')
    expect(sidebar).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith('c')
    emit({ method: 'thread/archived', params: {} })
    expect(search).toHaveBeenLastCalledWith(undefined)
    service.dispose()
    const count = history.mock.calls.length
    emit({ method: 'turn/completed', params: { threadId: 'late' } })
    expect(history).toHaveBeenCalledTimes(count)
  })

  it.each(['failed', 'interrupted', 'completed', 'inProgress'])('enriches only already terminal failures (%s) and persists visible problem indicators', async status => {
    const { service, runtime, emit } = fixture()
    runtime.rpc.mockResolvedValue({ data: [{ id: 'turn-1', status }] })
    const result = await service.sidebarThreadStatus.snapshot(['a', 'a'])
    expect(result.a).toBe(['failed', 'interrupted'].includes(status))
    expect(runtime.rpc).toHaveBeenCalledTimes(1)
    expect(runtime.rpc).toHaveBeenCalledWith('thread/turns/list', { threadId: 'a', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
    if (['failed', 'interrupted'].includes(status)) {
      expect(await runtime.interruptions.snapshot()).toEqual({ a: [{ turnId: 'turn-1', kind: 'quota' }] })
      const stored = JSON.parse(await readFile(join(home, 'codexapp-thread-interruptions-v1.json'), 'utf8'))
      expect(stored.a).toEqual([{ turnId: 'turn-1', kind: 'quota' }])
      await runtime.ignoredErrors.set('a', 'turn-1', true)
      emit({ method: 'thread/quotaErrorIgnored/changed', params: { threadId: 'a' } })
      expect(await service.sidebarThreadStatus.snapshot(['a'])).toEqual({ a: false })
    } else {
      expect(runtime.getStreamEvents).not.toHaveBeenCalled()
      expect(await runtime.interruptions.snapshot()).toEqual({})
    }
  })

  it('uses native history for search, cached title reads and file signatures without duplicate RPC', async () => {
    const { service, runtime, emit } = fixture()
    const path = join(home, 'rollout.jsonl')
    await writeFile(path, 'synthetic rollout')
    await writeFile(join(home, '.codex-global-state.json'), JSON.stringify({ 'thread-titles': { titles: { a: 'Named fixture' }, order: ['a'] } }))
    runtime.rpc.mockImplementation(async (method, params) => {
      if (method === 'thread/list') return { data: [{ id: 'a', path, cwd: '', preview: 'other' }], nextCursor: null }
      if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', text: 'body needle' }] }], nextCursor: null }
      throw new Error('unexpected RPC: ' + method + JSON.stringify(params))
    })
    const search = (query: string, mode: 'title' | 'body' = 'title') => service.search.search(query, 20, new AbortController().signal, mode)
    expect((await search('Named')).threadIds).toEqual(['a'])
    expect(runtime.rpc).toHaveBeenCalledTimes(1)
    expect((await search('needle', 'body')).threadIds).toEqual(['a'])
    expect(runtime.rpc).toHaveBeenCalledTimes(2)
    expect(runtime.rpc).toHaveBeenLastCalledWith('thread/turns/list', { threadId: 'a', limit: 50, sortDirection: 'desc', itemsView: 'full', cursor: null })
    await search('needle', 'body')
    expect(runtime.rpc).toHaveBeenCalledTimes(2)
    await writeFile(path, 'changed synthetic rollout with different size')
    await search('needle', 'body')
    expect(runtime.rpc).toHaveBeenCalledTimes(3)
    const preferences = createPreferencesService({ mutateGlobalState: queueWorkspaceRootsMutation, invalidateThreadSearch: id => service.search.invalidate(id) })
    await preferences.saveTitle('a', 'Updated fixture')
    expect((await search('Updated')).threadIds).toEqual(['a'])
    expect(runtime.rpc).toHaveBeenCalledTimes(4)
    emit({ method: 'turn/completed', params: { threadId: 'a' } })
    await search('needle', 'body')
    expect(runtime.rpc).toHaveBeenCalledTimes(6)
  })

  it('invalidates a pending sidebar response and keeps malformed metadata isolated', async () => {
    const { service, runtime, emit } = fixture()
    let finish!: (value: unknown) => void
    runtime.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = service.sidebarThreadStatus.snapshot(['a'])
    await vi.waitFor(() => expect(runtime.rpc).toHaveBeenCalledTimes(1))
    emit({ method: 'turn/started', params: { threadId: 'a' } })
    finish({ data: [{ id: 'turn-1', status: 'failed' }] })
    expect(await pending).toEqual({ a: null })
    runtime.rpc.mockResolvedValue({ invalid: [] })
    expect(await service.sidebarThreadStatus.snapshot(['a'])).toEqual({ a: null })
  })
})
