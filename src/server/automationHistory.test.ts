import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationHistory } from './automationHistory'
import type { AutomationRun } from './automationStore'
import { AutomationStore } from './automationStore'
import * as files from './automationDefinition'
import { maintainAutomationHistory } from './automationHistoryMaintenance'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function run(index: number): AutomationRun {
  return { runId: `fixture-${String(index).padStart(4, '0')}`, automationId: 'fixture', target: '/fixture', kind: 'cron', key: `manual:fixture:${index}`, revision: 'r1', trigger: 'manual', scheduledAt: 1000, timezone: 'Asia/Shanghai', createdAt: 1000, startedAt: 1000, finishedAt: 2000, status: 'completed', attempt: 1, threadId: 'thread-fixture', turnId: `turn-${index}`, model: 'fixture', error: null, errorCode: null }
}
describe('complete automation history', () => {
  it('paginates 207 tied timestamps as 100/100/7 without duplicates across archive and live state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-history-')); roots.push(root)
    const history = new AutomationHistory(root), all = Array.from({ length: 207 }, (_, i) => run(i))
    await history.archive(all.slice(0, 150))
    // Simulate a crash after archive writes but before pruning the scheduling state.
    const live = all.slice(100), found: AutomationRun[] = []; let cursor: string | null = null
    for (const expected of [100, 100, 7]) {
      const page = await history.page('fixture', live, cursor, 100)
      expect(page.data).toHaveLength(expected); found.push(...page.data); cursor = page.nextCursor
    }
    expect(cursor).toBeNull(); expect(new Set(found.map(run => run.runId)).size).toBe(207)
    expect(found[0].runId).toBe('fixture-0206'); expect(found.at(-1)?.runId).toBe('fixture-0000')
    expect((await history.page('fixture', live, null, 5)).data).toHaveLength(5)
    await expect(history.page('fixture', live, 'bad-cursor', 100)).rejects.toThrow('游标')
    await expect(history.page('fixture', live, null, 101)).rejects.toThrow('数量')
  })
  it('preserves old records and manual request keys after restart; archive writes invalidate an empty listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-history-')); roots.push(root)
    const history = new AutomationHistory(root)
    expect((await history.page('fixture', [], null, 5)).data).toEqual([])
    await history.archive([run(1)])
    expect((await history.page('fixture', [], null, 5)).data[0].runId).toBe(run(1).runId)
    const restarted = new AutomationHistory(root)
    expect(await restarted.findByKey(run(1).key)).toEqual(run(1))
    expect(await restarted.findById('fixture', run(1).runId)).toEqual(run(1))
    expect(await restarted.findById('another-task', run(1).runId)).toBeUndefined()
  })
})

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const fileName = (row: AutomationRun) => `${String(row.createdAt).padStart(16, '0')}_${encodeURIComponent(row.runId)}.json`
async function root() { const value = await mkdtemp(join(tmpdir(), 'automation-history-')); roots.push(value); return value }
async function put(path: string, value: unknown) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)) }
const factPath = (root: string, kind: string, key: string) => join(root, 'history-v2', kind, digest(key).slice(0, 2), `${digest(key)}.json`)

it.each([1, 2, 3, 4, 5])('recovers an archive interrupted after write %i without replaying or duplicating it', async checkpoint => {
  const directory = await root()
  const original = files.writeAutomationFileAtomic
  let writes = 0
  const write = vi.spyOn(files, 'writeAutomationFileAtomic').mockImplementation(async (path, body) => {
    await original(path, body)
    if (++writes === checkpoint) throw new Error('fixture process exit')
  })
  await expect(new AutomationHistory(directory).archive([run(1)])).rejects.toThrow('fixture process exit')
  write.mockRestore()
  const recovered = new AutomationHistory(directory)
  expect(await recovered.findByKey(run(1).key)).toEqual(run(1))
  expect((await recovered.page('fixture', [run(1)], null, 100)).data).toEqual([run(1)])
  expect(await readdir(join(directory, 'history-v2', 'pending'))).toEqual([])
})

it('reconciles legacy bodies with a missing key index, preserves their bytes and rejects legacy indexes whose bodies are gone', async () => {
  const directory = await root(), row = run(1)
  const path = join(directory, 'history', digest(row.automationId), fileName(row))
  const original = JSON.stringify(row, null, 2)
  await put(path, original)
  const history = new AutomationHistory(directory)
  expect(await history.findByKey(row.key)).toEqual(row)
  expect(await readFile(path, 'utf8')).toBe(original)
  expect((await history.page(row.automationId, [], null, 10)).data).toEqual([row])
  const lost = run(2)
  await put(join(directory, 'history-keys', `${digest(lost.key)}.json`), { automationId: lost.automationId, name: fileName(lost) })
  await expect(history.findByKey(lost.key)).rejects.toThrow('禁止重新提交')
})

it('uses a surviving permanent fact when either copy is missing/corrupt, rejects ambiguous damage and rebuilds display indexes', async () => {
  const directory = await root(), row = run(1)
  const history = new AutomationHistory(directory)
  await history.archive([row])
  await rm(factPath(directory, 'keys', row.key))
  expect(await history.findByKey(row.key)).toEqual(row)
  await history.repairIndexes()
  await writeFile(factPath(directory, 'records', row.key), '{broken')
  expect(await history.findByKey(row.key)).toEqual(row)
  await history.repairIndexes()
  await rm(join(directory, 'history-v2', 'ids'), { recursive: true })
  expect(await history.findById(row.automationId, row.runId)).toEqual(row)
  await rm(join(directory, 'history-v2', 'timeline'), { recursive: true })
  await history.repairIndexes()
  expect((await new AutomationHistory(directory).page(row.automationId, [], null, 10)).data).toEqual([row])
  await writeFile(factPath(directory, 'records', row.key), '{broken')
  await writeFile(factPath(directory, 'keys', row.key), '{broken')
  await expect(history.findByKey(row.key)).rejects.toThrow()
  await expect(history.archive([{ ...row, runId: 'replacement' }])).rejects.toThrow()
})

it('keeps permanent identities immutable and supports offline export that old readers can use', async () => {
  const home = await root(), directory = join(home, 'codexapp-automations'), row = run(1)
  await mkdir(directory)
  const history = new AutomationHistory(directory)
  await history.archive([row])
  await expect(history.archive([{ ...row, runId: 'duplicate-key-new-run' }])).rejects.toThrow('防重记录冲突')
  const lease = new AutomationStore(directory)
  expect(await lease.acquire(Date.now())).toBe(true)
  await expect(maintainAutomationHistory(home, true)).rejects.toThrow('仍在运行')
  await lease.release()
  expect(await maintainAutomationHistory(home, true)).toEqual({ records: 1, exportedLegacy: true })
  const index = JSON.parse(await readFile(join(directory, 'history-keys', `${digest(row.key)}.json`), 'utf8'))
  // Use exactly the old lookup algorithm, without the new reader.
  const legacy = JSON.parse(await readFile(join(directory, 'history', digest(index.automationId), index.name), 'utf8'))
  expect(legacy).toEqual(row)
})

it('paginates across daily segments while bounding resident day indexes and preserving timestamp ties', async () => {
  const directory = await root(), history = new AutomationHistory(directory)
  const rows = Array.from({ length: 45 }, (_, i) => ({ ...run(i), createdAt: Date.UTC(2026, 0, 1 + i) }))
  await history.archive(rows)
  let cursor: string | null = null
  const found: string[] = []
  do {
    const page = await history.page('fixture', rows.slice(40), cursor, 3)
    found.push(...page.data.map(row => row.runId))
    cursor = page.nextCursor
  } while (cursor)
  expect(found).toEqual([...rows].reverse().map(row => row.runId))
  expect((history as any).names.size).toBeLessThanOrEqual(32)
  expect(await readdir(join(directory, 'history-v2', 'timeline', digest('fixture')))).toHaveLength(45)
})
