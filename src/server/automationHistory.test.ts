import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationHistory } from './automationHistory'
import type { AutomationRun } from './automationStore'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
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
