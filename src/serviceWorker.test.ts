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
  const api = runInNewContext(`${source}\n({ networkFirstNavigation, cacheName: CACHE_NAME })`, {
    self: { addEventListener: vi.fn() }, caches: { open: vi.fn(async () => cache) }, fetch, Response, URL,
  }) as { networkFirstNavigation: (request: string) => Promise<Response>; cacheName: string }
  return { api, cache, fetch }
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
})
