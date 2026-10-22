import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createDeliveryRoutes } from './deliveryRoutes.js'

type TestResponse = { statusCode: number; body: string; headers: Record<string, string> }

let capturedResponse: TestResponse | null = null

async function invoke(
  handler: ReturnType<typeof createDeliveryRoutes>,
  method: string,
  pathname: string,
  body?: unknown,
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
    { readJsonBody: () => readAnyJsonBody(request as never as IncomingMessage) },
  )
}

function fixture(overrides: Partial<Parameters<typeof createDeliveryRoutes>[0]['backendQueueProcessor']> = {}) {
  const backendQueueProcessor = {
    deliveryContext: vi.fn(async () => 'context-1'),
    readDeliveryStatuses: vi.fn(async () => [{ id: 'message-1', status: 'sent' }]),
    submit: vi.fn(async () => ({ id: 'message-1', status: 'sent' })),
    mutate: vi.fn(async () => ({ state: { thread: [] } })),
    ...overrides,
  }
  return { backendQueueProcessor, handler: createDeliveryRoutes({ backendQueueProcessor }) }
}

function expectResponse(statusCode: number, payload: unknown) {
  expect(capturedResponse).toEqual({
    statusCode,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

describe('delivery routes', () => {
  it('reads the delivery context and status filters', async () => {
    const { handler, backendQueueProcessor } = fixture()
    expect(await invoke(handler, 'GET', '/codex-api/delivery-context')).toBe(true)
    expectResponse(200, { data: { contextId: 'context-1' } })
    expect(await invoke(handler, 'GET', '/codex-api/delivery-status?threadId=thread-1&ids=message-1,,message-2')).toBe(true)
    expectResponse(200, { data: [{ id: 'message-1', status: 'sent' }] })
    expect(backendQueueProcessor.readDeliveryStatuses).toHaveBeenCalledWith('thread-1', ['message-1', 'message-2'])
  })

  it('submits delivery payloads and maps failures to 409', async () => {
    const { handler, backendQueueProcessor } = fixture({
      submit: vi.fn(async () => { throw new Error('无效的发送内容') }),
    })
    await invoke(handler, 'POST', '/codex-api/delivery', { protocol: 2 })
    expect(backendQueueProcessor.submit).toHaveBeenCalledWith({ protocol: 2 })
    expectResponse(409, { error: '无效的发送内容' })
  })

  it('mutates queue state with the legacy contract', async () => {
    const { handler, backendQueueProcessor } = fixture()
    await invoke(handler, 'POST', '/codex-api/thread-queue-state', { protocol: 2, type: 'add' })
    expect(backendQueueProcessor.mutate).toHaveBeenCalledWith({ protocol: 2, type: 'add' })
    expectResponse(200, { data: { state: { thread: [] } } })
    await invoke(handler, 'PUT', '/codex-api/thread-queue-state')
    expectResponse(409, { error: '队列接口已更新，请刷新页面后重试' })
  })

  it('maps mutation failures and ignores unrelated routes', async () => {
    const { handler, backendQueueProcessor } = fixture({
      mutate: vi.fn(async () => { throw new Error('队列保存失败') }),
    })
    await invoke(handler, 'POST', '/codex-api/thread-queue-state')
    expectResponse(409, { error: '队列保存失败' })
    expect(await invoke(handler, 'GET', '/codex-api/unknown')).toBe(false)
    expect(backendQueueProcessor.deliveryContext).toHaveBeenCalledTimes(0)
  })
})
