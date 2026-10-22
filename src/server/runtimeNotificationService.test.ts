import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IgnoredQuotaErrors } from './ignoredQuotaErrors.js'
import { createRuntimeNotificationObserver } from './runtimeNotificationService.js'
import { ThreadCompletionList } from './threadCompletionList.js'
import { ThreadInterruptionList } from './threadInterruptionList.js'

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'sidux-runtime-observer-')) })
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

function fixture(overrides: Partial<Parameters<typeof createRuntimeNotificationObserver>[0]> = {}) {
  const dependencies = {
    completions: new ThreadCompletionList(join(home, 'completions.json')),
    interruptions: new ThreadInterruptionList(home, new IgnoredQuotaErrors(home)),
    quotaResume: { observe: vi.fn() },
    observeAccountQuota: vi.fn(async () => {}),
    automationEngine: { notification: vi.fn() },
    threadGoalReader: { observe: vi.fn() },
    threadCompactionGate: { observe: vi.fn() },
    processActivity: { observe: vi.fn() },
    ...overrides,
  }
  return { dependencies, observe: createRuntimeNotificationObserver(dependencies) }
}

describe('shared runtime notification business dispatch', () => {
  it('persists completion/problems once while forwarding in the original order', async () => {
    const { dependencies, observe } = fixture()
    const completion = vi.spyOn(dependencies.completions, 'complete')
    const problems = vi.spyOn(dependencies.interruptions, 'observe')
    const notification = { method: 'turn/completed', params: { threadId: ' a ', turn: { id: 'turn-1', status: 'failed', error: { message: 'quota exceeded' } } } }
    observe(notification)
    await completion.mock.results[0]!.value
    await problems.mock.results[0]!.value
    expect(completion).toHaveBeenCalledTimes(1)
    expect(completion).toHaveBeenCalledWith(' a ', 'turn-1')
    expect(await (dependencies.completions as ThreadCompletionList).read()).toEqual({ ' a ': 'turn-1' })
    expect(await (dependencies.interruptions as ThreadInterruptionList).snapshot()).toEqual({ ' a ': [{ turnId: 'turn-1', kind: 'quota' }] })
    const calls = [completion, problems, dependencies.quotaResume.observe, dependencies.automationEngine.notification, dependencies.threadGoalReader.observe, dependencies.threadCompactionGate.observe, dependencies.processActivity.observe]
    const orders = calls.map(call => vi.mocked(call).mock.invocationCallOrder[0]!)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    for (const call of calls.slice(2)) expect(call).toHaveBeenCalledWith(notification)
  })

  it('gates completion/problems/quota persistence while forwarding other notifications once', async () => {
    const { dependencies, observe } = fixture()
    const complete = vi.spyOn(dependencies.completions, 'complete')
    const problem = vi.spyOn(dependencies.interruptions, 'observe')
    const updated = { method: 'account/rateLimits/updated', params: { quota: 'fixture' } }
    observe(updated)
    await vi.mocked(dependencies.observeAccountQuota).mock.results[0]!.value
    expect(dependencies.observeAccountQuota).toHaveBeenCalledTimes(1)
    expect(dependencies.observeAccountQuota).toHaveBeenCalledWith(updated.params)
    expect(complete).not.toHaveBeenCalled()
    expect(problem).not.toHaveBeenCalled()
    observe({ method: 'unrelated', params: {} })
    expect(dependencies.quotaResume.observe).toHaveBeenCalledTimes(2)
    expect(dependencies.automationEngine.notification).toHaveBeenCalledTimes(2)
  })

  it('isolates asynchronous persistence failures and retains the fallback turn id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const complete = vi.fn(async () => { throw new Error('synthetic completion error') })
    const problem = vi.fn(async () => { throw new Error('synthetic problem error') })
    const { dependencies, observe } = fixture({ completions: { complete }, interruptions: { observe: problem }, observeAccountQuota: vi.fn(async () => { throw new Error('synthetic quota error') }) })
    observe({ method: 'turn/completed', params: { threadId: 'a', turnId: 'turn-fallback' } })
    observe({ method: 'account/rateLimits/updated', params: {} })
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2))
    expect(complete).toHaveBeenCalledWith('a', 'turn-fallback')
    expect(dependencies.processActivity.observe).toHaveBeenCalledTimes(2)
    expect(error.mock.calls.map(row => row[0])).toEqual(['Failed to persist completion list', 'Failed to persist conversation problem indicators'])
  })
})
