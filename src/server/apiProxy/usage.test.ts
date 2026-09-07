import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProxyUsageStore, extractUsage } from './usage.js'
const homes: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })
const first = '0123456789abcdef'
const second = 'abcdef0123456789'
async function store() {
  const home = await mkdtemp(join(tmpdir(), 'api-usage-'))
  homes.push(home)
  const store = new ProxyUsageStore(home)
  await store.ready
  return { home, store }
}
it('settles once, isolates keys, preserves restart and distinguishes unknown from zero', async () => {
  const f = await store()
  const finish = f.store.begin(first)
  finish('completed', extractUsage({ usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 8 } } }))
  finish('interrupted')
  f.store.begin(first)('interrupted')
  f.store.begin(second)('failed', extractUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } }))
  f.store.begin(first, true)('completed')
  f.store.begin(first)('rejected')
  await f.store.close()
  const restarted = new ProxyUsageStore(f.home)
  await restarted.ready
  expect(restarted.summary().keys[first].cumulative).toMatchObject({ requests: 3, completed: 1, interrupted: 1, rejected: 1, total: 13, cached: 8, unknown: 1, catalogs: 1 })
  expect(restarted.summary().keys[second].cumulative).toMatchObject({ requests: 1, failed: 1, total: 0, unknown: 0 })
  await restarted.close()
})
it('uses the display timezone for local day boundaries and never sums token details twice', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-07T15:55:00Z'))
  const f = await store()
  f.store.begin(first)('completed', extractUsage({ response: { usage: { input_tokens: 9, output_tokens: 6, total_tokens: 15, output_tokens_details: { reasoning_tokens: 4 } } } }))
  vi.setSystemTime(new Date('2026-09-07T16:05:00Z'))
  expect(f.store.summary('Asia/Shanghai').keys[first].today.requests).toBe(0)
  expect(f.store.summary('UTC').keys[first].today.total).toBe(15)
  expect(f.store.summary('Asia/Shanghai').keys[first].week.requests).toBe(1)
  await f.store.close()
})
it('preserves unreadable state while new usage remains visible in memory', async () => {
  const f = await store()
  await f.store.close()
  await writeFile(join(f.home, 'usage.json'), '{')
  const broken = new ProxyUsageStore(f.home)
  await broken.ready
  broken.begin(first)('completed')
  await broken.close()
  expect(broken.summary().error).toBeTruthy()
  expect(broken.summary().keys[first].cumulative.unknown).toBe(1)
  expect(await readFile(join(f.home, 'usage.json'), 'utf8')).toBe('{')
})

it('retains counters after a write failure and recovers on a later flush', async () => {
  const f = await store()
  await mkdir(join(f.home, 'usage.json'))
  f.store.begin(first)('completed')
  await f.store.flush()
  expect(f.store.summary().error).toBeTruthy()
  expect(f.store.summary().keys[first].cumulative.requests).toBe(1)
  await rm(join(f.home, 'usage.json'), { recursive: true })
  f.store.begin(first)('failed')
  await f.store.close()
  expect(f.store.summary().error).toBeNull()
  const restarted = new ProxyUsageStore(f.home)
  await restarted.ready
  expect(restarted.summary().keys[first].cumulative).toMatchObject({ requests: 2, completed: 1, failed: 1 })
  await restarted.close()
})
