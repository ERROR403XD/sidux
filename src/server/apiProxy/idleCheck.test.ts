import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
const { checkIdle } = createRequire(import.meta.url)('../../../scripts/check-codexapp-idle.cjs')
afterEach(() => vi.unstubAllGlobals())
function responses(api: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    const payload = path === '/codex-api/automation-runtime' ? { data: { ready: true, activeCount: 0, queuedCount: 0 } }
      : path === '/codex-api/thread-queue-state' ? { data: {} }
      : path === '/codex-api/server-requests/pending' ? { data: [] }
      : path === '/codex-api/rpc' ? { result: { data: [], nextCursor: null } }
      : api
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}
describe('release API activity inventory', () => {
  it('fails closed when proxy activity cannot be read', async () => {
    responses({})
    await expect(checkIdle('http://fixture')).rejects.toThrow('API proxy activity')
  })
  it('does not treat a disabled outlet with closing connections as idle', async () => {
    responses({ data: { settings: { enabled: false }, activity: { connections: 1, activeRequests: 0 } } })
    expect((await checkIdle('http://fixture')).idle).toBe(false)
  })
  it('accepts an explicit empty snapshot and permits only an explicit legacy exemption', async () => {
    responses({ data: { settings: { enabled: false }, activity: { connections: 0, activeRequests: 0 } } })
    expect((await checkIdle('http://fixture')).idle).toBe(true)
    responses({})
    expect((await checkIdle('http://fixture', { legacyApiProxy: true })).idle).toBe(true)
  })
})
