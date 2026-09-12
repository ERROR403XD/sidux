import { describe, expect, it, vi } from 'vitest'
import { SidebarThreadStatusReader } from './sidebarThreadStatusReader'

const failed = { data: [{ id: 'final', status: 'failed', error: { message: 'quota exceeded' } }] }
describe('final-turn status reader', () => {
  it('reads only final turn metadata and shares a bounded cache', async () => {
    let now = 100
    const rpc = vi.fn().mockResolvedValue(failed)
    const reader = new SidebarThreadStatusReader(rpc, () => now)
    expect(await reader.snapshot(['a', 'a'])).toEqual({ a: true })
    await reader.snapshot(['a'])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('thread/turns/list', { threadId: 'a', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
    now += 30001
    await reader.snapshot(['a'])
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('invalidates failures after a new turn and rejects late stale replies', async () => {
    let resolve!: (v: unknown) => void
    const rpc = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue({ data: [{ id: 'new', status: 'completed', error: null }] })
    const reader = new SidebarThreadStatusReader(rpc)
    const pending = reader.snapshot(['a'])
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    reader.invalidate('a')
    resolve(failed)
    expect(await pending).toEqual({ a: null })
    expect(await reader.snapshot(['a'])).toEqual({ a: false })
  })
  it('isolates errors and limits actual outstanding RPCs even after timeouts', async () => {
    const rpc = vi.fn().mockImplementation(() => new Promise(() => {}))
    const reader = new SidebarThreadStatusReader(rpc, Date.now, 5)
    const ids = Array.from({ length: 12 }, (_, i) => `id-${i}`)
    const result = await reader.snapshot(ids)
    expect(Object.values(result).every(value => value === null)).toBe(true)
    await reader.snapshot(['other'])
    expect(rpc).toHaveBeenCalledTimes(4)
  })
  it('refreshes a changed catalog revision and treats an empty new conversation as unblocked', async () => {
    const rpc = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({ data: [{ id: 'recovered', status: 'completed', error: null }] }).mockRejectedValueOnce(new Error('thread x is not materialized yet; thread/turns/list is unavailable before first user message'))
    const reader = new SidebarThreadStatusReader(rpc)
    expect(await reader.snapshot(['a'], { a: 'before' })).toEqual({ a: true })
    expect(await reader.snapshot(['a'], { a: 'after' })).toEqual({ a: false })
    expect(await reader.snapshot(['empty'])).toEqual({ empty: false })
  })
  it('retains successful peers when one read fails and rejects malformed requests', async () => {
    const reader = new SidebarThreadStatusReader(async (_, p) => {
      if (p.threadId === 'bad') throw new Error('unavailable')
      return failed
    })
    expect(await reader.snapshot(['good', 'bad'])).toEqual({ good: true, bad: null })
    await expect(reader.snapshot(Array(101).fill('a'))).rejects.toThrow()
  })
})
