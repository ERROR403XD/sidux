import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createRouteDispatcher, getErrorMessage, JsonObjectBodyError, readAnyJsonBody, readJsonObjectBody } from './httpUtils.js'

describe('server HTTP utilities', () => {
  it('extracts direct and nested error messages without leaking empty values', () => {
    expect(getErrorMessage(new Error('direct'), 'fallback')).toBe('direct')
    expect(getErrorMessage({ error: ' nested ' }, 'fallback')).toBe('nested')
    expect(getErrorMessage({ error: { message: 'nested message' } }, 'fallback')).toBe('nested message')
    expect(getErrorMessage({ error: '' }, 'fallback')).toBe('fallback')
    expect(getErrorMessage({ error: { message: ' ' } }, 'fallback')).toBe('fallback')
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
  })

  it('reads only JSON object request bodies', async () => {
    const emptyRequest = new PassThrough()
    emptyRequest.end()
    await expect(readJsonObjectBody(emptyRequest as never)).resolves.toEqual({})

    const objectRequest = new PassThrough()
    objectRequest.end('{"value":1}')
    await expect(readJsonObjectBody(objectRequest as never)).resolves.toEqual({ value: 1 })

    for (const body of ['[]', 'invalid']) {
      const request = new PassThrough()
      request.end(body)
      const action = readJsonObjectBody(request as never)
      await expect(action).rejects.toBeInstanceOf(JsonObjectBodyError)
    }
  })

  it('reads the same arbitrary JSON body shapes as the bridge', async () => {
    for (const [body, expected] of [['', null], ['   ', null], ['{"value":1}', { value: 1 }], ['[1,2]', [1, 2]]] as const) {
      const request = new PassThrough()
      request.end(body)
      await expect(readAnyJsonBody(request as never as IncomingMessage)).resolves.toEqual(expected)
    }
    const invalid = new PassThrough()
    invalid.end('invalid')
    await expect(readAnyJsonBody(invalid as never as IncomingMessage)).rejects.toThrow(SyntaxError)
  })

  it('dispatches routes in order without invoking handlers after a match', async () => {
    const calls: string[] = []
    const request = { method: 'GET', url: '/codex-api/fixture?x=1' } as IncomingMessage
    const response = { statusCode: 200, end: () => {} } as unknown as ServerResponse
    const readJsonBody = vi.fn(async () => null)
    const dispatch = createRouteDispatcher([
      async () => {
        calls.push('first')
        return false
      },
      async (incoming, outgoing, url, context) => {
        calls.push(incoming.method ?? '', url.pathname)
        outgoing.end()
        return outgoing === response
      },
      async () => {
        calls.push('third')
        return true
      },
    ])

    await expect(dispatch(request, response, new URL(request.url!, 'http://localhost'), { readJsonBody })).resolves.toBe(true)
    expect(calls).toEqual(['first', 'GET', '/codex-api/fixture'])
  })
})
