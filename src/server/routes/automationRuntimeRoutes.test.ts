import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationExecuteOutcome } from '../automationExecute.js'
import type { AutomationRun } from '../automationStore.js'
import { readAnyJsonBody } from '../httpUtils.js'
import { createAutomationRuntimeRoutes } from './automationRuntimeRoutes.js'

type TestResponse = { statusCode: number; body: string; headers: Record<string, string> }

let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createAutomationRuntimeRoutes>,
  method: string,
  pathname: string,
  body?: unknown,
  readJsonBodyOverride?: () => Promise<unknown>,
): Promise<boolean> {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end(body === undefined ? '' : JSON.stringify(body))
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: string) => { headers[name] = value },
    end: (chunk?: unknown) => {
      capturedResponse = {
        statusCode: response.statusCode,
        body: typeof chunk === 'string' ? chunk : '',
        headers,
      }
    },
  } as unknown as ServerResponse
  capturedResponse = null
  return handler(
    request as never as IncomingMessage,
    response,
    new URL(pathname, 'http://localhost'),
    { readJsonBody: readJsonBodyOverride ?? (() => readAnyJsonBody(request as never as IncomingMessage)) },
  )
}

const run = (status: AutomationRun['status'] = 'queued'): AutomationRun => ({
  runId: 'run-1', automationId: 'automation-1', target: '/repo', kind: 'cron', key: 'key', revision: 'revision',
  trigger: 'manual', scheduledAt: 1, timezone: 'UTC', status, attempt: 1, createdAt: 2, startedAt: null,
  finishedAt: null, threadId: null, turnId: null, model: null, errorCode: null, error: null,
})

function fixture() {
  const automationEngine = {
    readyPromise: Promise.resolve(),
    snapshot: vi.fn(() => ({ ready: true, activeCount: 0 })),
    historyPage: vi.fn(async () => ({ data: [], nextCursor: null })),
    drain: vi.fn(async () => ({ ready: true, draining: true })),
    manual: vi.fn(async () => run()),
    tick: vi.fn(async () => {}),
  }
  const handler = createAutomationRuntimeRoutes({
    appServer: { liveActivity: () => ['/repo'] },
    automationEngine,
    executeAutomation: vi.fn(async (): Promise<AutomationExecuteOutcome> => ({ status: 200, body: { data: { queued: true } } })),
  })
  return { automationEngine, handler }
}

function expectResponse(statusCode: number, payload: unknown) {
  expect(capturedResponse).toEqual({
    statusCode,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

describe('automation runtime routes', () => {
  it('reads live activity and scheduler state', async () => {
    const { handler, automationEngine } = fixture()
    expect(await invoke(handler, 'GET', '/codex-api/runtime/activity')).toBe(true)
    expectResponse(200, { data: ['/repo'] })
    expect(await invoke(handler, 'GET', '/codex-api/automation-runtime')).toBe(true)
    expectResponse(200, { data: { ready: true, activeCount: 0 } })
    expect(automationEngine.snapshot).toHaveBeenCalledTimes(1)
  })

  it('executes automations and schedules a tick only on success', async () => {
    const { handler, automationEngine } = fixture()
    await invoke(handler, 'POST', '/automation/execute', { id: 'automation-1' })
    expectResponse(200, { data: { queued: true } })
    expect(automationEngine.tick).toHaveBeenCalledTimes(1)
    await invoke(handler, 'POST', '/automation/execute', 'not-json', () => Promise.reject(new SyntaxError()))
    expectResponse(400, { error: '请求体不是有效的 JSON' })
  })

  it('reads history and toggles drain', async () => {
    const { handler, automationEngine } = fixture()
    expect(await invoke(handler, 'GET', '/codex-api/automation-runs?automationId=automation-1&cursor=next&limit=20')).toBe(true)
    expect(automationEngine.historyPage).toHaveBeenCalledWith('automation-1', 'next', 20)
    await invoke(handler, 'POST', '/codex-api/automation-runtime/drain', { draining: false })
    expect(automationEngine.drain).toHaveBeenCalledWith(false)
    await invoke(handler, 'POST', '/codex-api/automation-runtime/drain', {})
    expect(automationEngine.drain).toHaveBeenCalledWith(true)
  })

  it('runs manual thread, project and retry targets', async () => {
    const { handler, automationEngine } = fixture()
    await invoke(handler, 'POST', '/codex-api/thread-automation/run', { automationId: 'automation-1', threadId: 'thread-1', requestId: 'request-1' })
    await invoke(handler, 'POST', '/codex-api/project-automation/run', { automationId: 'automation-1', projectName: '/repo', requestId: 'request-2' })
    await invoke(handler, 'POST', '/codex-api/automation-run/retry', { automationId: 'automation-1', target: '/repo', requestId: 'request-3', retryOf: 'run-0' })
    expect(automationEngine.manual.mock.calls).toEqual([
      ['automation-1', 'thread-1', 'request-1', undefined],
      ['automation-1', '/repo', 'request-2', undefined],
      ['automation-1', '/repo', 'request-3', 'run-0'],
    ])
    expect(automationEngine.tick).toHaveBeenCalledTimes(3)
    expect(await invoke(handler, 'GET', '/codex-api/unknown')).toBe(false)
  })
})
