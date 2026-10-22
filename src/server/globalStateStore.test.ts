import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { queueGlobalStateMutation, readGlobalState, writeGlobalState } from './globalStateStore.js'

it('serializes read-modify-write mutations', async () => {
  const home = await mkdtemp(join(tmpdir(), 'global-state-'))
  const path = join(home, '.codex-global-state.json')
  try {
    await writeFile(path, '{}\n', 'utf8')
    const updates = Array.from({ length: 20 }, (_, index) => {
      return queueGlobalStateMutation(path, async () => {
        const payload = await readGlobalState(path)
        payload.count = Number(payload.count ?? 0) + 1
        payload[`key-${index}`] = true
        await writeGlobalState(path, payload)
      })
    })
    await Promise.all(updates)
    const payload = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(payload.count).toBe(20)
    expect(Object.keys(payload).filter(key => key.startsWith('key-'))).toHaveLength(20)
  } finally {
    const { rm } = await import('node:fs/promises')
    await rm(home, { recursive: true, force: true })
  }
})

it('keeps later mutations runnable after a failure', async () => {
  const first = vi.fn(async () => { throw new Error('expected') })
  const second = vi.fn(async () => 'ok')
  const firstQueued = queueGlobalStateMutation('/tmp/global-state-failure.json', first)
  const secondQueued = queueGlobalStateMutation('/tmp/global-state-failure.json', second)
  await expect(firstQueued).rejects.toThrow('expected')
  await expect(secondQueued).resolves.toBe('ok')
})

it('does not block an independent file behind a pending transaction', async () => {
  let release!: () => void
  const blocked = queueGlobalStateMutation('/tmp/global-state-one.json', () => new Promise<void>(resolve => { release = resolve }))
  await expect(queueGlobalStateMutation('/tmp/global-state-two.json', async () => 'independent')).resolves.toBe('independent')
  release()
  await blocked
})
