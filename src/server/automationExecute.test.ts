import { describe, expect, it, vi } from 'vitest'
import { executeAutomationByRequest } from './automationExecute.js'
import { AutomationRequestError, type AutomationRequestErrorCode } from './automationRequestError.js'
import type { AutomationEngine } from './automationEngine.js'
import type { AutomationRun } from './automationStore.js'

const run = (overrides: Partial<AutomationRun> = {}): AutomationRun => ({
  runId: 'run-1', automationId: 'task', target: '/tmp/work', kind: 'cron', key: 'manual:task:/tmp/work:req', revision: 'rev',
  trigger: 'manual', scheduledAt: 0, timezone: 'UTC', status: 'queued', attempt: 1,
  createdAt: 0, startedAt: null, finishedAt: null, threadId: null, turnId: null, model: null, errorCode: null, error: null,
  ...overrides,
})

function stubEngine(execute: (id: string) => Promise<AutomationRun>): AutomationEngine {
  return { execute: vi.fn(execute) } as unknown as AutomationEngine
}

describe('external automation execute endpoint mapping', () => {
  it('rejects payloads without a usable task id', async () => {
    for (const payload of [null, undefined, {}, { id: '' }, { id: '   ' }, { id: 123 }]) {
      expect(await executeAutomationByRequest(stubEngine(async () => run()), payload)).toEqual({
        status: 400, body: { error: '缺少有效的自动化任务 id' },
      })
    }
  })
  it('trims the id, ignores extra fields, and returns the queued run', async () => {
    const engine = stubEngine(async () => run())
    const outcome = await executeAutomationByRequest(engine, { id: ' task ', target: '/elsewhere', requestId: 'req-1', unrelated: true })
    expect(outcome).toMatchObject({ status: 200, body: { data: { queued: true, run: { runId: 'run-1' } } } })
    expect(vi.mocked(engine.execute)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(engine.execute)).toHaveBeenCalledWith('task')
  })
  it.each([
    ['not_found', 404], ['queued_conflict', 409], ['not_ready', 503],
    ['draining', 503], ['invalid_target', 400], ['storage_failed', 500],
  ] as const)('maps structured %s independently of message wording', async (code, status) => {
    const outcome = await executeAutomationByRequest(stubEngine(async () => {
      throw new AutomationRequestError(code as AutomationRequestErrorCode, '任意文案', status)
    }), { id: 'task' })
    expect(outcome).toEqual({ status, body: { error: '任意文案', code } })
  })
  it('does not misclassify or expose unexpected internal errors', async () => {
    const outcome = await executeAutomationByRequest(stubEngine(async () => {
      throw new Error('找不到 private fixture storage')
    }), { id: 'task' })
    expect(outcome).toEqual({ status: 500, body: { error: '自动化服务内部错误，请检查服务与存储状态', code: 'internal_error' } })
  })
})
