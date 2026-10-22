import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody } from '../httpUtils.js'
import { createWorkspaceRoutes } from './workspaceRoutes.js'
import { createWorkspaceService, type WorkspaceRootsState } from '../workspaceStateService.js'

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
  handler: ReturnType<typeof createWorkspaceRoutes>,
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

describe('workspace routes', () => {
  it('returns the current workspace state', async () => {
    const state: WorkspaceRootsState = {
      order: ['/root'],
      labels: { '/root': 'Root' },
      active: ['/root'],
      projectOrder: [],
      remoteProjects: [],
    }
    const handler = createWorkspaceRoutes(createWorkspaceService({
      readState: async () => state,
      updateState: vi.fn(),
    }))

    const result = await invoke(handler, 'GET', '/codex-api/workspace-roots-state')

    expect(result.handled).toBe(true)
    expect(result.response).toEqual({ statusCode: 200, body: JSON.stringify({ data: state }) })
  })

  it('updates editable state and preserves server-owned project membership', async () => {
    const existingState: WorkspaceRootsState = {
      order: ['/old'],
      labels: { '/old': 'Old' },
      active: ['/old'],
      projectOrder: ['virtual:project'],
      remoteProjects: [{ id: 'remote', hostId: 'host', remotePath: '/remote', label: 'Remote' }],
    }
    let capturedUpdater: ((state: WorkspaceRootsState) => WorkspaceRootsState) | undefined
    const updateState = async (updater: (state: WorkspaceRootsState) => WorkspaceRootsState) => {
      capturedUpdater = updater
    }
    const handler = createWorkspaceRoutes(createWorkspaceService({
      readState: vi.fn(),
      updateState,
    }))

    const result = await invoke(handler, 'PUT', '/codex-api/workspace-roots-state', {
      order: ['/new', '/new-duplicate', '/new', '', 2],
      labels: { '/new': 'New', '/invalid': 2 },
      active: ['/new'],
      projectOrder: ['ignored'],
      remoteProjects: ['ignored'],
    })

    expect(result.handled).toBe(true)
    expect(result.response).toEqual({ statusCode: 200, body: JSON.stringify({ ok: true }) })
    expect(capturedUpdater).toBeDefined()
    const nextState = capturedUpdater!(existingState)
    expect(nextState.order).toEqual(['/new', '/new-duplicate'])
    expect(nextState.labels).toEqual({ '/new': 'New' })
    expect(nextState.active).toEqual(['/new'])
    expect(nextState.projectOrder).toEqual(['ignored'])
    expect(nextState.remoteProjects).toEqual(existingState.remoteProjects)
  })

  it('keeps existing project order when the partial payload omits it', async () => {
    const existingState: WorkspaceRootsState = {
      order: [],
      labels: {},
      active: [],
      projectOrder: ['virtual:project'],
      remoteProjects: [],
    }
    const updateState = vi.fn()
    const handler = createWorkspaceRoutes(createWorkspaceService({
      readState: vi.fn(),
      updateState: updateState,
    }))

    await invoke(handler, 'PUT', '/codex-api/workspace-roots-state', { order: [] })

    expect(updateState).toHaveBeenCalledWith(expect.any(Function))
    const updater = updateState.mock.calls[0][0] as (state: WorkspaceRootsState) => WorkspaceRootsState
    expect(updater(existingState).projectOrder).toEqual(['virtual:project'])
  })

  it('rejects a non-object body', async () => {
    const handler = createWorkspaceRoutes(createWorkspaceService({
      readState: vi.fn(),
      updateState: vi.fn(),
    }))

    const result = await invoke(handler, 'PUT', '/codex-api/workspace-roots-state', [])

    expect(result.handled).toBe(true)
    expect(result.response).toEqual({
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid body: expected object' }),
    })
  })

  it('does not handle unrelated paths', async () => {
    const handler = createWorkspaceRoutes(createWorkspaceService({
      readState: vi.fn(),
      updateState: vi.fn(),
    }))

    capturedResponse = null
    await expect(invoke(handler, 'GET', '/codex-api/unknown')).resolves.toEqual({
      handled: false,
      response: null,
    })
  })
})
