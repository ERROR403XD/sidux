import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectoryPluginCache, nextLocalPluginRefresh } from './directoryPluginCache'

const directories: string[] = []
const caches: DirectoryPluginCache[] = []
afterEach(async () => {
  caches.splice(0).forEach(cache => cache.dispose())
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function setup(rpc = vi.fn().mockResolvedValue({ marketplaces: [{ name: 'sample' }] })) {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-cache-'))
  directories.push(directory)
  const cache = new DirectoryPluginCache(directory, rpc, Date.now, false)
  caches.push(cache)
  return { directory, cache, rpc }
}
describe('local plugin catalog', () => {
  it('coalesces concurrent reads and survives server restart without an upstream request', async () => {
    const { cache, rpc, directory } = await setup()
    const [a, b] = await Promise.all([cache.read(), cache.read()])
    expect(a).toEqual(b)
    expect(rpc).toHaveBeenCalledTimes(1)
    cache.dispose()
    const restarted = new DirectoryPluginCache(directory, rpc, Date.now, false)
    caches.push(restarted)
    expect(await restarted.read()).toEqual(a)
    expect(rpc).toHaveBeenCalledTimes(1)
    await restarted.read({ forceRefetch: true })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('isolates project scopes and retains complete results through partial failures', async () => {
    const { cache, rpc } = await setup()
    const original = await cache.read({ cwds: ['/a'] })
    await cache.read({ cwds: ['/b'] })
    rpc.mockResolvedValueOnce({ marketplaces: [], marketplaceLoadErrors: [{ message: 'offline' }] })
    expect(await cache.read({ cwds: ['/a'], forceRefetch: true })).toEqual({ ...original, marketplaceLoadErrors: [{ message: 'offline' }] })
    expect(await cache.read({ cwds: ['/a'] })).toEqual(original)
    expect(rpc).toHaveBeenCalledTimes(3)
  })
  it('refreshes cached scopes sequentially and schedules the next local 02:00', async () => {
    const { cache, rpc } = await setup()
    await cache.read()
    await cache.refreshKnown()
    expect(rpc).toHaveBeenCalledTimes(2)
    const before = new Date(2026, 8, 10, 1, 59).getTime()
    expect(new Date(nextLocalPluginRefresh(before)).getHours()).toBe(2)
    expect(new Date(nextLocalPluginRefresh(new Date(2026, 8, 10, 2).getTime())).getDate()).toBe(11)
  })
  it('keeps disk scopes bounded when multiple new projects refresh concurrently', async () => {
    const { cache, directory } = await setup()
    await Promise.all(Array.from({ length: 11 }, (_, i) => cache.read({ cwds: [`/initial/${i}`] })))
    await Promise.all(Array.from({ length: 12 }, (_, i) => cache.read({ cwds: [`/new/${i}`] })))
    expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(12)
  })

})
