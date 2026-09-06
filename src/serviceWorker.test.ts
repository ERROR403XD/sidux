import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
function fixture(initial?: Response) {
  let saved = initial
  const cache = {
    match: vi.fn(async () => saved?.clone()),
    put: vi.fn(async (_key: string, response: Response) => { saved = response.clone() }),
  }
  const fetch = vi.fn()
  const open = vi.fn(async () => cache)
  const api = runInNewContext(`${source}\n({ networkFirstNavigation, networkFirstStatic, cacheName: CACHE_NAME })`, {
    self: { addEventListener: vi.fn() }, caches: { open }, fetch, Response, URL,
  }) as { networkFirstNavigation: (request: string) => Promise<Response>; networkFirstStatic: (request: { destination: string }) => Promise<Response>; cacheName: string }
  return { api, cache, fetch, open }
}

describe('service worker navigation recovery', () => {
  it('keeps a valid shell after an HTTP failure and later offline navigation', async () => {
    const { api, cache, fetch } = fixture(new Response('working shell'))
    fetch.mockResolvedValueOnce(new Response('temporary failure', { status: 503 })).mockRejectedValueOnce(new Error('offline'))
    expect(await (await api.networkFirstNavigation('/')).text()).toBe('working shell')
    expect(await (await api.networkFirstNavigation('/')).text()).toBe('working shell')
    expect(cache.put).not.toHaveBeenCalled()
    expect(api.cacheName).toBe('codexweb-shell-v3')
  })

  it('exposes the HTTP failure when no successful shell has been saved', async () => {
    const { api, cache, fetch } = fixture()
    fetch.mockResolvedValue(new Response('temporary failure', { status: 500 }))
    expect((await api.networkFirstNavigation('/')).status).toBe(500)
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('refreshes the shell after recovery and serves it offline', async () => {
    const { api, fetch } = fixture(new Response('old shell'))
    fetch.mockResolvedValueOnce(new Response('new shell')).mockRejectedValueOnce(new Error('offline'))
    expect(await (await api.networkFirstNavigation('/')).text()).toBe('new shell')
    expect(await (await api.networkFirstNavigation('/')).text()).toBe('new shell')
  })

  it('serves a successful network response even if the cache is full', async () => {
    const { api, cache, fetch } = fixture(new Response('old shell'))
    cache.put.mockRejectedValueOnce(new Error('cache full'))
    fetch.mockResolvedValue(new Response('new shell'))
    expect(await (await api.networkFirstNavigation('/')).text()).toBe('new shell')
  })

  it('falls back to a cached script instead of caching an HTML response as JavaScript', async () => {
    const { api, cache, fetch } = fixture(new Response('valid script', { headers: { 'Content-Type': 'text/javascript' } }))
    fetch.mockResolvedValue(new Response('<html>wrong resource</html>', { headers: { 'Content-Type': 'text/html' } }))
    expect(await (await api.networkFirstStatic({ destination: 'script' })).text()).toBe('valid script')
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('rejects an already polluted script cache on network failure', async () => {
    const { api, fetch } = fixture(new Response('<html>old pollution</html>', { headers: { 'Content-Type': 'text/html' } }))
    fetch.mockRejectedValue(new Error('offline'))
    expect((await api.networkFirstStatic({ destination: 'script' })).type).toBe('error')
  })

  it('caches valid styles and serves them when an old chunk is missing', async () => {
    const { api, fetch } = fixture()
    fetch.mockResolvedValueOnce(new Response('body { color: red }', { headers: { 'Content-Type': 'text/css; charset=utf-8' } }))
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }))
    expect(await (await api.networkFirstStatic({ destination: 'style' })).text()).toContain('color: red')
    expect(await (await api.networkFirstStatic({ destination: 'style' })).text()).toContain('color: red')
  })

  it('does not make working network requests depend on available cache storage', async () => {
    const { api, open, fetch } = fixture()
    open.mockRejectedValue(new Error('cache unavailable'))
    fetch.mockResolvedValueOnce(new Response('working page'))
      .mockResolvedValueOnce(new Response('working script', { headers: { 'Content-Type': 'application/javascript' } }))
    expect(await (await api.networkFirstNavigation('/')).text()).toBe('working page')
    expect(await (await api.networkFirstStatic({ destination: 'script' })).text()).toBe('working script')
  })
})
