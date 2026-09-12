import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { IgnoredQuotaErrors } from './ignoredQuotaErrors'
import { SidebarThreadStatusReader } from './sidebarThreadStatusReader'

it('persists per-turn acknowledgements, supports undo and never hides a later quota failure', async () => {
  const home = await mkdtemp(tmpdir() + '/ignored-quota-')
  try {
    const marks = new IgnoredQuotaErrors(home)
    let turn = 'first'
    const rpc = vi.fn(async () => ({ data: [{ id: turn, status: 'failed', error: { message: 'quota exceeded' } }] }))
    const reader = new SidebarThreadStatusReader(rpc, Date.now, 8000, (id, turnId) => marks.has(id, turnId))
    expect(await reader.snapshot(['chat'])).toEqual({ chat: true })
    await Promise.all([marks.set('chat', 'first', true), marks.set('other', 'first', true)])
    reader.invalidate('chat')
    expect(await reader.snapshot(['chat'])).toEqual({ chat: false })
    expect(await new IgnoredQuotaErrors(home).list('chat')).toEqual(['first'])
    turn = 'second'
    reader.invalidate('chat')
    expect(await reader.snapshot(['chat'])).toEqual({ chat: true })
    turn = 'first'
    await marks.set('chat', 'first', false)
    reader.invalidate('chat')
    expect(await reader.snapshot(['chat'])).toEqual({ chat: true })
    expect(await marks.has('other', 'first')).toBe(true)
    await expect(marks.set('../bad', 'first', true)).rejects.toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})
