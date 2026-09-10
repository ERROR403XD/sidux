import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { AccountActivationHistory, activationHistoryCutoff } from './accountActivationHistory'
import type { ActivationRun } from '../accountActivation'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
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
  expect(page.runs.map(row => [row.accountId, row.status])).toEqual([['a', 'sent'], ['b', 'skipped']])
  expect((await history.page(2)).runs[0].scheduledAt).toBe(Date.parse('2026-09-09T08:00:00Z'))
  expect((await history.page(999)).page).toBe(3)
  await writeFile(join(directory, 'not-history.txt'), 'keep')
  now = Date.parse('2026-09-11T00:00:00Z')
  await history.prune()
  expect((await history.page()).slots).toHaveLength(2)
  expect(await readFile(join(directory, 'not-history.txt'), 'utf8')).toBe('keep')
  await expect(readFile(join(directory, '2026-06-10.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  const restarted = new AccountActivationHistory(directory, () => now)
  await restarted.initialize([run('2026-09-09', '13:00', 'a', 'sent')])
  expect((await restarted.page()).runs).toHaveLength(2)
})
it('clamps calendar month boundaries and handles an empty archive', async () => {
  expect(activationHistoryCutoff(Date.parse('2026-05-31T12:00:00Z'))).toBe('2026-02-28')
  const directory = await mkdtemp(join(tmpdir(), 'activation-history-'))
  directories.push(directory)
  const history = new AccountActivationHistory(directory)
  await history.initialize([])
  expect(await history.page(Number.NaN)).toEqual({ slots: [], page: 1, runs: [] })
})
