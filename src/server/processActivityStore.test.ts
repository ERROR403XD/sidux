import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookStatusLabel, readHookRun } from '../processActivity'
import { ProcessActivityStore } from './processActivityStore'

const directories: string[] = []
const stores: ProcessActivityStore[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codexapp-hook-test-'))
  directories.push(directory)
  const path = join(directory, 'observations.json')
  const store = new ProcessActivityStore(path)
  stores.push(store)
  return { path, store }
}
const event = (status: string, options: Record<string, unknown> = {}) => ({ method: status === 'running' ? 'hook/started' : 'hook/completed', params: {
  threadId: 'thread-a', turnId: 'turn-a', run: { id: 'session-start:0:file', startedAt: 1788727979, eventName: 'sessionStart', status,
    entries: status === 'running' ? [] : [{ kind: 'context', text: 'NATIVE_HOOK_OUTPUT' }], ...options },
} })
afterEach(async () => {
  for (const store of stores.splice(0)) await store.flush()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('bounded hook and command observation history', () => {
  it('retains final status over late starts, repeated hook IDs across turns, and restores old running status as unconfirmed', async () => {
    const { store, path } = await fixture()
    store.observe(event('completed'))
    store.observe(event('running'))
    const later = event('running', { startedAt: 1788727980 })
    later.params.turnId = 'turn-b'
    store.observe(later)
    store.observe({ ...event('completed'), params: { ...event('completed').params, threadId: 'thread-b' } })
    await store.flush()
    const restored = new ProcessActivityStore(path)
    stores.push(restored)
    const snapshot = await restored.snapshot('thread-a')
    expect(snapshot.runs).toHaveLength(2)
    expect(snapshot.runs[0]!.status).toBe('running')
    expect(hookStatusLabel(snapshot.runs[0]!)).toBe('状态待确认')
    expect(snapshot.runs[1]!.status).toBe('completed')
    expect(snapshot.runs[1]!.startedAt).toBe(1788727979)
    expect((await restored.snapshot('thread-b')).runs).toHaveLength(1)
  })

  it('keeps events received during restoration and marks observations on native process exit', async () => {
    const { store, path } = await fixture()
    store.observe(event('running'))
    await store.flush()
    const restored = new ProcessActivityStore(path)
    stores.push(restored)
    restored.observe(event('completed'))
    expect((await restored.snapshot('thread-a')).runs[0]?.status).toBe('completed')
    restored.observe(event('running', { startedAt: 1788727990 }))
    restored.observe({ method: 'codexapp/runtime/stopped', params: {} })
    expect(hookStatusLabel((await restored.snapshot('thread-a')).runs[0]!)).toBe('状态待确认')
  })

  it('bounds per-run, per-thread and total byte retention without writing on terminal deltas', async () => {
    const { store, path } = await fixture()
    const entries = Array.from({ length: 30 }, () => ({ kind: 'context', text: '界'.repeat(5000) }))
    const normalized = readHookRun(event('completed', { entries }).params.run, 'thread-a', 'turn-a')!
    expect(normalized.entries.reduce((n, e) => n + e.text.length, 0)).toBe(16000)
    expect(normalized.truncated).toBe(true)
    for (let index = 0; index < 220; index++) store.observe(event('completed', { id: String(index) }))
    expect((await store.snapshot('thread-a')).runs).toHaveLength(200)
    for (let index = 0; index < 1200; index++) store.observe({ ...event('completed', { id: String(index), entries }), params: {
      ...event('completed', { id: String(index), entries }).params, threadId: 'thread-' + index,
    } })
    await store.flush()
    expect((await stat(path)).size).toBeLessThan(4 * 1024 * 1024 + 1000)
    const before = await readFile(path, 'utf8')
    for (let index = 0; index < 100; index++) store.observe({ method: 'item/commandExecution/outputDelta', params: { threadId: 'terminal-thread', itemId: 'command', delta: 'a'.repeat(1000) } })
    expect(store.output('terminal-thread', 'command')?.text).toHaveLength(32768)
    expect(store.output('terminal-thread', 'command')?.truncated).toBe(true)
    await store.flush()
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(store.output('another-thread', 'command')).toBeNull()
    expect((await store.snapshot('thread-a')).limited).toBe(true)
  })

  it('preserves corrupt history and exposes the persistence failure', async () => {
    const { path } = await fixture()
    await writeFile(path, '{invalid')
    const store = new ProcessActivityStore(path)
    stores.push(store)
    store.observe(event('completed'))
    expect((await store.snapshot('thread-a')).error).toContain('仅在内存')
    await store.flush()
    expect(await readFile(path, 'utf8')).toBe('{invalid')
  })

  it('retains command completion and exit code over delayed deltas and clears output on runtime restart', async () => {
    const { store } = await fixture()
    store.observe({ method: 'item/completed', params: { threadId: 'a', item: { id: 'cmd', type: 'commandExecution', status: 'failed', aggregatedOutput: 'FAILED_OUTPUT', exitCode: 2 } } })
    store.observe({ method: 'item/commandExecution/outputDelta', params: { threadId: 'a', itemId: 'cmd', delta: 'LATE' } })
    expect(store.output('a', 'cmd')).toMatchObject({ text: 'FAILED_OUTPUT', exitCode: 2, status: 'failed' })
    store.runtimeStopped()
    expect(store.output('a', 'cmd')).toBeNull()
  })
})
