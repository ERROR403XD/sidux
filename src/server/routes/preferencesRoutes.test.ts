import { createPreferencesService } from '../preferencesService.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createPreferencesRoutes } from './preferencesRoutes.js'

type TestResponse = {
  statusCode: number
  body: string
}

let capturedResponse: TestResponse | null = null

function createRequest(method: string, body?: unknown): IncomingMessage {
  const request = new PassThrough()
  Object.defineProperty(request, 'method', { value: method })
  Object.defineProperty(request, 'url', { value: '' })
  request.end(body === undefined ? '' : JSON.stringify(body))
  return request as unknown as IncomingMessage
}

function createResponse(): ServerResponse {
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(function (this: ServerResponse, chunk?: unknown) {
      capturedResponse = {
        statusCode: this.statusCode,
        body: typeof chunk === 'string' ? chunk : '',
      }
    }),
  } as unknown as ServerResponse
}

async function invoke(
  handler: ReturnType<typeof createPreferencesRoutes>,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ handled: boolean; response: TestResponse | null }> {
  const request = createRequest(method, body)
  const response = createResponse()
  const handled = await handler(
    request,
    response,
    new URL(pathname, 'http://localhost'),
    { readJsonBody: () => readAnyJsonBody(request) },
  )

  return { handled, response: capturedResponse }
}

describe('preferences routes', () => {
  let codexHome: string

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'preferences-routes-'))
    vi.stubEnv('CODEX_HOME', codexHome)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(codexHome, { recursive: true, force: true })
  })

  it('merges persisted and session-index titles and skips malformed entries', async () => {
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({
      unrelated: 'keep',
      'thread-titles': {
        order: ['persisted'],
        titles: { persisted: 'Persisted title' },
      },
    }))
    await writeFile(join(codexHome, 'session_index.jsonl'), [
      '{"id":"session","thread_name":"Old title","updated_at":"2026-10-09T10:00:00Z"}',
      'not-json',
      '{"id":"session","thread_name":"","updated_at":"2026-10-09T11:00:00Z"}',
      '{"id":"session","thread_name":"New title","updated_at":"2026-10-09T12:00:00Z"}',
      '',
    ].join('\n'))

    const handler = createPreferencesRoutes(createPreferencesService({ invalidateThreadSearch: vi.fn(), mutateGlobalState: value => value() }))
    const result = await invoke(handler, 'GET', '/codex-api/thread-titles')

    expect(result.handled).toBe(true)
    expect(JSON.parse(result.response!.body)).toEqual({
      data: {
        order: ['session', 'persisted'],
        titles: { persisted: 'Persisted title', session: 'New title' },
      },
    })
  })

  it('updates a title, preserves unrelated state, and invalidates search only after success', async () => {
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({ unrelated: 'keep' }))
    const invalidateThreadSearch = vi.fn()
    const mutateGlobalState = async <T>(mutation: () => Promise<T>) => mutation()
    const handler = createPreferencesRoutes(createPreferencesService({ invalidateThreadSearch, mutateGlobalState }))

    const result = await invoke(handler, 'PUT', '/codex-api/thread-titles', { id: 'thread-id', title: 'Updated' })

    expect(result.handled).toBe(true)
    expect(result.response!.statusCode).toBe(200)
    expect(invalidateThreadSearch).toHaveBeenCalledWith('thread-id')
    expect(JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'))).toEqual({
      unrelated: 'keep',
      'thread-titles': { order: ['thread-id'], titles: { 'thread-id': 'Updated' } },
    })

    const failedMutationHandler = createPreferencesRoutes(createPreferencesService({
      invalidateThreadSearch,
      mutateGlobalState: async () => { throw new Error('write failed') },
    }))
    await expect(invoke(failedMutationHandler, 'PUT', '/codex-api/thread-titles', { id: 'other', title: 'Unused' }))
      .rejects.toThrow('write failed')
    expect(invalidateThreadSearch).toHaveBeenCalledTimes(1)
  })

  it('rejects a title update without an id', async () => {
    const handler = createPreferencesRoutes(createPreferencesService({ invalidateThreadSearch: vi.fn(), mutateGlobalState: vi.fn() }))
    const result = await invoke(handler, 'PUT', '/codex-api/thread-titles', { title: 'Updated' })

    expect(result.handled).toBe(true)
    expect(result.response!.statusCode).toBe(400)
    expect(JSON.parse(result.response!.body)).toEqual({ error: 'Missing id' })
  })

  it('normalizes pinned thread ids', async () => {
    await writeFile(join(codexHome, '.codex-global-state.json'), JSON.stringify({ unrelated: 'keep' }))
    const handler = createPreferencesRoutes(createPreferencesService({ invalidateThreadSearch: vi.fn(), mutateGlobalState: value => value() }))

    await invoke(handler, 'PUT', '/codex-api/thread-pins', {
      threadIds: ['first', '', 'second', 'first', 3],
    })
    const result = await invoke(handler, 'GET', '/codex-api/thread-pins')

    expect(JSON.parse(result.response!.body)).toEqual({ data: { threadIds: ['first', 'second'] } })
    expect(JSON.parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8'))).toEqual({
      unrelated: 'keep',
      'pinned-thread-ids': ['first', 'second'],
    })
  })

  it('normalizes first-launch card dismissal and ignores non-true values', async () => {
    const handler = createPreferencesRoutes(createPreferencesService({ invalidateThreadSearch: vi.fn(), mutateGlobalState: value => value() }))

    await invoke(handler, 'PUT', '/codex-api/preferences/first-launch-plugins-card', { dismissed: 'yes' })
    let result = await invoke(handler, 'GET', '/codex-api/preferences/first-launch-plugins-card')
    expect(JSON.parse(result.response!.body)).toEqual({ data: { dismissed: false } })

    await invoke(handler, 'PUT', '/codex-api/preferences/first-launch-plugins-card', { dismissed: true })
    result = await invoke(handler, 'GET', '/codex-api/preferences/first-launch-plugins-card')
    expect(JSON.parse(result.response!.body)).toEqual({ data: { dismissed: true } })
  })

  it('refreshes session-index titles after the file signature changes', async () => {
    const sessionIndexPath = join(codexHome, 'session_index.jsonl')
    await writeFile(sessionIndexPath, JSON.stringify({
      id: 'session',
      thread_name: 'Before',
      updated_at: '2026-10-09T10:00:00Z',
    }) + '\n')
    const handler = createPreferencesRoutes(createPreferencesService({ invalidateThreadSearch: vi.fn(), mutateGlobalState: value => value() }))

    const before = await invoke(handler, 'GET', '/codex-api/thread-titles')
    await utimes(sessionIndexPath, new Date('2026-10-09T12:00:00Z'), new Date('2026-10-09T12:00:00Z'))
    await writeFile(sessionIndexPath, JSON.stringify({
      id: 'session',
      thread_name: 'After',
      updated_at: '2026-10-09T11:00:00Z',
    }) + '\n')
    await utimes(sessionIndexPath, new Date('2026-10-09T12:00:01Z'), new Date('2026-10-09T12:00:01Z'))
    const after = await invoke(handler, 'GET', '/codex-api/thread-titles')

    expect(JSON.parse(before.response!.body).data.titles.session).toBe('Before')
    expect(JSON.parse(after.response!.body).data.titles.session).toBe('After')
  })
  it('shares conversation choices across service instances, merges concurrent entries and imports only missing memories', async () => {
    const make = () => createPreferencesService({ invalidateThreadSearch: vi.fn(), mutateGlobalState: value => value() })
    const first = make(), second = make()
    const a = { model: 'astra', provider: 'codex', effort: 'ultra', tier: 'priority' }
    const b = { model: 'sol', provider: 'codex', effort: 'low', tier: '' }
    await Promise.all([
      first.saveConversationPreferences({ threads: { A: { source: 'web', saved: a } } }),
      second.saveConversationPreferences({ threads: { B: { source: 'web', saved: b } } }),
    ])
    await second.saveConversationPreferences({ defaults: b, remember: false })
    await first.saveConversationPreferences({ migrate: { defaults: a, remember: true, threads: {
      A: { source: 'web', saved: b }, C: { source: 'web', saved: a },
    } } })
    expect(await make().readConversationPreferences('A')).toEqual({ defaults: b, remember: false, threads: { A: { source: 'web', saved: a } } })
    expect((await make().readConversationPreferences('B')).threads.B.saved).toEqual(b)
    expect((await make().readConversationPreferences('C')).threads.C.saved).toEqual(a)
    // The endpoint returns only the selected conversation, even when storage contains more.
    const handler = createPreferencesRoutes(make())
    const response = await invoke(handler, 'GET', '/codex-api/preferences/conversations?threadId=A')
    expect(JSON.parse(response.response!.body).data.threads).toEqual({ A: { source: 'web', saved: a } })
    const invalid = await invoke(handler, 'PUT', '/codex-api/preferences/conversations', {})
    expect(invalid.response!.statusCode).toBe(400)
    const saved = await invoke(handler, 'PUT', '/codex-api/preferences/conversations', { threads: { B: { source: 'web', saved: a } } })
    expect(saved.response!.statusCode).toBe(200)
    expect((await second.readConversationPreferences('A')).threads.A.saved).toEqual(a)
    expect((await second.readConversationPreferences('B')).threads.B.saved).toEqual(a)
  })

})
