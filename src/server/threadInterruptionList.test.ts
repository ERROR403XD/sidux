import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { IgnoredQuotaErrors } from './ignoredQuotaErrors'
import { ThreadInterruptionList } from './threadInterruptionList'

it('keeps errors across reading, later success and restart; only per-turn ignore removes them, with undo and distinct later errors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interruptions-'))
  try {
    const marks = new IgnoredQuotaErrors(home)
    const changed = vi.fn()
    const list = new ThreadInterruptionList(home, marks, changed)
    await Promise.all([
      list.record('a', { id: 'network', status: 'failed', error: { message: 'connection reset' } }),
      list.record('a', { id: 'quota', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } }),
      list.record('b', { id: 'manual', status: 'interrupted', error: null }),
    ])
    const expected = { a: [{ turnId: 'network', kind: 'error' }, { turnId: 'quota', kind: 'quota' }] }
    expect(await list.snapshot()).toEqual(expected)
    await list.observe('turn/started', { threadId: 'a', turnId: 'new' })
    await list.observe('turn/completed', { threadId: 'a', turn: { id: 'new', status: 'completed' } })
    await list.observe('codexapp/completions/changed', { threadId: 'a', token: null })
    expect(await list.snapshot()).toEqual(expected)
    expect(await new ThreadInterruptionList(home, new IgnoredQuotaErrors(home)).snapshot()).toEqual(expected)
    await marks.set('a', 'quota', true)
    await list.publish('a')
    expect(await list.snapshot()).toEqual({ a: [expected.a[0]] })
    expect(changed).toHaveBeenLastCalledWith('a', [expected.a[0]])
    await marks.set('a', 'network', true)
    expect(await list.snapshot()).toEqual({})
    await marks.set('a', 'quota', false)
    expect(await list.snapshot()).toEqual({ a: [expected.a[1]] })
    await list.record('a', { id: 'next-quota', status: 'failed', error: { message: '429 quota exceeded' } })
    expect((await list.snapshot()).a).toHaveLength(2)
    await list.record('a', { id: 'next-quota', status: 'failed', error: { message: '429 quota exceeded' } })
    expect((await list.snapshot()).a).toHaveLength(2)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('correlates quota auto-interrupts, distinguishes manual stops and recovered retries, and never reads user content as an error', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interruptions-'))
  try {
    const list = new ThreadInterruptionList(home, new IgnoredQuotaErrors(home))
    const notify = (method: string, params: unknown) => list.observe(method, params)
    await notify('error', { threadId: 'a', turnId: 'quota', error: { message: 'quota exceeded' }, willRetry: true })
    await notify('turn/cancelled', { threadId: 'a', turnId: 'quota' })
    await notify('error', { threadId: 'b', turnId: 'retry', error: { message: 'network retry' }, willRetry: true })
    await notify('turn/completed', { threadId: 'b', turn: { id: 'retry', status: 'interrupted', error: null } })
    await notify('error', { threadId: 'c', turnId: 'old', error: { message: 'quota exceeded' } })
    await notify('turn/completed', { threadId: 'c', turn: { id: 'success', status: 'completed' } })
    await notify('error', { threadId: 'd', turnId: 'old', error: { message: 'quota exceeded' } })
    await notify('turn/completed', { threadId: 'd', turn: { id: 'different', status: 'interrupted' } })
    await notify('turn/completed', { threadId: 'e', turn: { id: 'user', status: 'completed', items: [{ text: 'quota failed' }] } })
    expect(await list.snapshot()).toEqual({ a: [{ turnId: 'quota', kind: 'quota' }] })
    await notify('turn/started', { threadId: 'native', turn: { id: 'system' } })
    await notify('thread/status/changed', { threadId: 'native', status: { type: 'systemError' } })
    expect((await list.snapshot()).native).toEqual([{ turnId: 'system', kind: 'error' }])
    await notify('thread/status/changed', { threadId: 'unknown', status: { type: 'systemError' } })
    expect((await list.snapshot()).unknown).toBeUndefined() // Never invent a turn ID.
    const disk = await readFile(join(home, 'codexapp-thread-interruptions-v1.json'), 'utf8')
    expect(disk).not.toContain('exceeded') // Persist IDs and kinds, not private error bodies.
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('preserves corrupt storage for recovery rather than silently replacing it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interruptions-'))
  try {
    const path = join(home, 'codexapp-thread-interruptions-v1.json')
    await writeFile(path, '{broken')
    const list = new ThreadInterruptionList(home, new IgnoredQuotaErrors(home))
    await expect(list.snapshot()).rejects.toThrow()
    await expect(list.record('a', { id: 't', status: 'failed' })).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{broken')
  } finally { await rm(home, { recursive: true, force: true }) }
})
