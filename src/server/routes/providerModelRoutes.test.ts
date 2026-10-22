import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeModelCapability } from '../../modelCapabilities.js'
import { CustomConnectionStore } from '../customConnectionStore.js'
import { FREE_MODE_STATE_FILE } from '../freeMode.js'
import { setJson } from '../httpUtils.js'
import { createProviderModelService, fetchCustomEndpointDefaultModel } from '../providerModelService.js'
import { createProviderModelRoutes } from './providerModelRoutes.js'

vi.mock('../freeMode.js', async importOriginal => ({
  ...await importOriginal<typeof import('../freeMode.js')>(),
  getFreeModels: async () => ['router-fixture-free'],
}))

const localFetch = globalThis.fetch
let home: string
let server: Server
let modelServer: Server
let base: string
let modelBase: string
let store: CustomConnectionStore
let rpc: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>
let config: Record<string, unknown>
let upstream: unknown
let upstreamStatus: number
let requests: Array<{ url: string; authorization?: string; flag?: string }>

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-provider-models-'))
  vi.stubEnv('CODEX_HOME', home)
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-fixture' } }))
  store = new CustomConnectionStore(home)
  await store.ready
  requests = []
  upstream = { data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }
  upstreamStatus = 200
  modelServer = createServer((req, res) => {
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization, flag: String(req.headers['x-flag'] ?? '') })
    setJson(res, upstreamStatus, upstream)
  })
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
  const upstreamAddress = modelServer.address()
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Missing model listener')
  modelBase = `http://127.0.0.1:${upstreamAddress.port}`
  config = { model_provider: 'fixture', model_providers: { fixture: { wire_api: 'responses', base_url: `${modelBase}/v1` } } }
  rpc = vi.fn(async method => {
    if (method !== 'config/read') throw new Error('Unexpected native RPC')
    return { config }
  })
  const route = createProviderModelRoutes(createProviderModelService({ rpc }, () => store))
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost')).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Account fallback' })
    }).catch(error => setJson(res, 502, { error: error.message }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  base = `http://127.0.0.1:${address.port}`
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const instance of [server, modelServer]) {
    instance.closeAllConnections()
    await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()))
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(home, { recursive: true, force: true })
})

async function get(path = '/codex-api/provider-models') {
  const response = await localFetch(`${base}${path}`)
  return { status: response.status, body: await response.json() as any }
}

describe('provider model HTTP/store/config/upstream contracts', () => {
  it('keeps configured URL/header normalization and one config/read plus one upstream request', async () => {
    config = { model_provider: 'fixture', model_providers: { fixture: {
      wire_api: 'responses', base_url: `${modelBase}/v1?keep=1`, query_params: { flag: true, count: 2, blank: '' },
      http_headers: { Authorization: 'header-fixture', 'X-Flag': true }, experimental_bearer_token: 'unused-fixture', env_key: 'NO_REAL_ENV',
    } } }
    expect(await get()).toEqual({ status: 200, body: { data: ['a', 'b'], providerId: 'fixture', source: 'provider' } })
    expect(rpc).toHaveBeenCalledExactlyOnceWith('config/read', {})
    expect(requests).toEqual([{ url: '/v1/models?keep=1&flag=true&count=2', authorization: 'header-fixture', flag: 'true' }])
    expect(console.warn).toHaveBeenCalledWith('[codex-provider-models]', 'provider discovery skipped env-backed auth/header expansion', { providerId: 'fixture', hasEnvKey: true, hasEnvHttpHeaders: false })
  })

  it('keeps custom connection priority and account lookup/fallthrough without upstream access', async () => {
    const id = 'a'.repeat(64)
    await writeFile(join(home, 'custom-connections.json'), JSON.stringify({ version: 1, activeId: id, connections: [{
      storageId: id, apiKey: 'synthetic-fixture', model: 'saved', models: [normalizeModelCapability('saved', 'custom')], manualModels: ['manual'],
    }] }))
    store = new CustomConnectionStore(home)
    await store.ready
    const selected = await get('/codex-api/provider-models?provider=openrouter')
    expect(selected.body).toMatchObject({ exclusive: true, source: 'custom' })
    expect(selected.body.data.map((row: any) => row.id)).toEqual(['saved', 'manual'])
    await store.select(null)
    expect((await get(`/codex-api/accounts/models?storageId=${id}`)).body.data.map((row: any) => row.id)).toEqual(['saved', 'manual'])
    expect((await get('/codex-api/accounts/models')).status).toBe(404)
    expect((await localFetch(`${base}/codex-api/provider-models`, { method: 'POST' })).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })

  it('keeps explicit provider selection and no-auth Zen filtering/offline defaults', async () => {
    expect((await get('/codex-api/provider-models?provider=codex')).body).toEqual({ data: [], providerId: '', source: 'provider', exclusive: true })
    expect((await get('/codex-api/provider-models?provider=openrouter_free')).body).toEqual({ data: ['router-fixture-free'], providerId: 'openrouter-free', source: 'provider', exclusive: true })
    await rm(join(home, 'auth.json'))
    const zen = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: ['paid', 'example-free', 'big-pickle'] }), { status: 200 }))
    vi.stubGlobal('fetch', zen)
    expect((await get()).body).toEqual({ data: ['example-free', 'big-pickle'], exclusive: true, source: 'opencode-zen' })
    expect(zen).toHaveBeenCalledTimes(1)
    zen.mockRejectedValueOnce(new Error('Offline'))
    expect((await get('/codex-api/provider-models?provider=opencode_zen')).body).toMatchObject({ data: ['big-pickle', 'minimax-m2.5-free', 'nemotron-3-super-free', 'trinity-large-preview-free'], exclusive: true, source: 'provider' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('preserves legacy custom ordering, dummy auth omission and empty failure response', async () => {
    await writeFile(join(home, FREE_MODE_STATE_FILE), JSON.stringify({ enabled: true, provider: 'custom', customBaseUrl: `${modelBase}/v1/`, apiKey: 'dummy', model: 'b', customKey: true }))
    expect((await get()).body).toEqual({ data: ['b', 'a'], exclusive: true, source: 'custom' })
    expect(requests[0]).toMatchObject({ url: '/v1/models', authorization: undefined })
    upstreamStatus = 503
    expect((await get()).body).toEqual({ data: [], exclusive: true, source: 'custom' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('keeps configured failures empty, native errors visible, and default-model discovery shared', async () => {
    upstream = { invalid: true }
    expect((await get()).body).toEqual({ data: [], providerId: 'fixture', source: 'provider' })
    expect(await fetchCustomEndpointDefaultModel(`${modelBase}/v1`, '')).toBe('')
    upstream = { models: ['preferred', 'later'] }
    expect(await fetchCustomEndpointDefaultModel(`${modelBase}/v1`, '')).toBe('preferred')
    rpc.mockRejectedValueOnce(new Error('Config unavailable'))
    expect(await get()).toEqual({ status: 502, body: { error: 'Config unavailable' } })
  })
})
