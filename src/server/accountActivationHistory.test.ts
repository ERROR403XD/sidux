import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountActivationHistory, activationHistoryCutoff } from './accountActivationHistory'
import type { ActivationRun } from '../accountActivation'
import * as persistence from './apiProxy/store'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
function run(date: string, time: string, accountId: string, status: ActivationRun['status'] = 'sent'): ActivationRun {
  return { key: JSON.stringify([accountId, 'UTC', date, time]), accountId, scheduledAt: Date.parse(`${date}T${time}:00Z`), status, reason: '' }
}
it('pages by scheduled activation, groups accounts, migrates old runs and retains three calendar months', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'activation-history-'))
  directories.push(directory)
  let now = Date.parse('2026-09-10T00:00:00Z')
  const history = new AccountActivationHistory(directory, () => now)
  await history.initialize([run('2026-06-09', '08:00', 'expired'), run('2026-06-10', '08:00', 'retained'), run('2026-09-09', '08:00', 'a'), run('2026-09-09', '13:00', 'a', 'preparing')])
  await history.record(run('2026-09-09', '13:00', 'a', 'sent'))
  await history.record(run('2026-09-09', '13:00', 'b', 'skipped'))
  const page = await history.page()
  expect(page.slots).toHaveLength(3)
  expect(page.runs.map(row => [row.accountId, row.status])).toEqual([['a', 'sent'], ['b', 'skipped'], ['a', 'sent'], ['retained', 'sent']])
  expect((await history.page(999)).page).toBe(1)
  await writeFile(join(directory, 'not-history.txt'), 'keep')
  now = Date.parse('2026-09-11T00:00:00Z')
  await history.prune()
  expect((await history.page()).slots).toHaveLength(2)
  expect(await readFile(join(directory, 'not-history.txt'), 'utf8')).toBe('keep')
  await expect(readFile(join(directory, '2026-06-10.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  const restarted = new AccountActivationHistory(directory, () => now)
  await restarted.initialize([run('2026-09-09', '13:00', 'a', 'sent')])
  expect((await restarted.page()).runs).toHaveLength(3)
})
it('clamps calendar month boundaries and handles an empty archive', async () => {
  expect(activationHistoryCutoff(Date.parse('2026-05-31T12:00:00Z'))).toBe('2026-02-28')
  const directory = await mkdtemp(join(tmpdir(), 'activation-history-'))
  directories.push(directory)
  const history = new AccountActivationHistory(directory)
  await history.initialize([])
  expect(await history.page(Number.NaN)).toEqual({ slots: [], page: 1, pageCount: 1, runs: [] })
})
it('shows at most five activation moments per page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'activation-history-pages-'))
  directories.push(directory)
  const now = Date.parse('2026-09-10T00:00:00Z')
  const history = new AccountActivationHistory(directory, () => now)
  const runs = Array.from({ length: 7 }, (_, index) => run('2026-09-09', `0${index}:00`.slice(-5), `account-${index}`))
  await history.initialize(runs)
  const first = await history.page()
  expect(first).toMatchObject({ page: 1, pageCount: 2 })
  expect(first.slots).toHaveLength(5)
  expect(first.runs).toHaveLength(5)
  const second = await history.page(2)
  expect(second).toMatchObject({ page: 2, pageCount: 2 })
  expect(second.slots).toHaveLength(2)
  expect(second.runs.map(run => run.accountId)).toEqual(['account-1', 'account-0'])
})

it.each(['legacy', 'stamped'] as const)('recovers an append missing from a %s index after restart, including identical legacy state', async format => {
  const directory = await mkdtemp(join(tmpdir(), 'activation-history-recovery-'))
  directories.push(directory)
  const now = () => Date.parse('2026-09-10T00:00:00Z')
  const history = new AccountActivationHistory(directory, now)
  await history.initialize([run('2026-09-09', '08:00', 'a')])
  const indexPath = join(directory, '2026-09-09.index.json')
  if (format === 'legacy') {
    const index = JSON.parse(await readFile(indexPath, 'utf8'))
    await writeFile(indexPath, JSON.stringify(index.slots))
  }
  const missing = run('2026-09-09', '09:00', 'b')
  await appendFile(join(directory, '2026-09-09.jsonl'), `${JSON.stringify(missing)}\n`)
  const restarted = new AccountActivationHistory(directory, now)
  await restarted.initialize([missing])
  expect((await restarted.page()).runs.map(row => row.accountId)).toEqual(['b', 'a'])
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  expect(index.bytes).toBe((await stat(join(directory, '2026-09-09.jsonl'))).size)
  expect(index.slots).toHaveLength(2)
  const write = vi.spyOn(persistence, 'privateJson')
  await restarted.page()
  expect(write).not.toHaveBeenCalled()
})

it('repairs failed index writes without publishing a dirty in-memory index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'activation-index-failure-'))
  directories.push(directory)
  const history = new AccountActivationHistory(directory, () => Date.parse('2026-09-10T00:00:00Z'))
  await history.initialize([run('2026-09-09', '08:00', 'a')])
  vi.spyOn(persistence, 'privateJson').mockRejectedValueOnce(new Error('index write failed'))
  await expect(history.record(run('2026-09-09', '09:00', 'b'))).rejects.toThrow('index write failed')
  expect((await history.page()).runs.map(row => row.accountId)).toEqual(['b', 'a'])
  expect(JSON.parse(await readFile(join(directory, '2026-09-09.index.json'), 'utf8')).slots).toHaveLength(2)
})

it('serializes concurrent readers and writers and isolates a truncated final append', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'activation-index-concurrent-'))
  directories.push(directory)
  const history = new AccountActivationHistory(directory, () => Date.parse('2026-09-10T00:00:00Z'))
  await history.initialize([run('2026-09-09', '08:00', 'a')])
  await appendFile(join(directory, '2026-09-09.jsonl'), '{"key":"truncated')
  const pending = history.record(run('2026-09-09', '09:00', 'b'))
  const page = history.page()
  const later = history.record(run('2026-09-09', '10:00', 'c'))
  await pending
  expect((await page).runs.map(row => row.accountId)).toEqual(['b', 'a'])
  await later
  expect((await history.page()).runs.map(row => row.accountId)).toEqual(['c', 'b', 'a'])
})
