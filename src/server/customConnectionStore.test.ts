import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { customConnectionEndpoints, customConnectionManualEndpoints, customConnectionModels, normalizeManualModels } from '../customConnections'
import { CustomConnectionStore, customRuntimeConfig } from './customConnectionStore'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'custom-connections-'))
  directories.push(home)
  await writeFile(join(home, 'auth.json'), 'primary-auth')
  await writeFile(join(home, 'accounts.json'), 'primary-selection')
  const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith('/models') ? { data: [{ id: 'sample' }] } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] })))
  const store = new CustomConnectionStore(home, fetcher as typeof fetch)
  const draft = { alias: 'Example', provider: 'custom', baseUrl: 'https://example.test/v1', apiKey: 'fixture-key', model: '', wireApi: 'responses' as const }
  return { home, store, draft, fetcher }
}
describe('custom connection credential boundaries', () => {
  it('persists per-connection Fast opt-in without re-probing or changing declared capabilities', async () => {
    const { store, draft, fetcher, home } = await fixture()
    const proof = await store.test(draft)
    await store.save({ ...draft, model: proof.model }, proof.token)
    const card = store.snapshot().connections[0]!
    const edit = { ...draft, model: proof.model, storageId: card.storageId, apiKey: '' }
    const calls = fetcher.mock.calls.length
    expect(customConnectionModels(card)[0]?.serviceTiers).toEqual([])
    await store.save({ ...edit, allowFast: true, manualModels: ['local/model'] }, '')
    expect(fetcher).toHaveBeenCalledTimes(calls)
    const reopened = new CustomConnectionStore(home)
    await reopened.ready
    const enabled = reopened.snapshot().connections[0]!
    expect(enabled.allowFast).toBe(true)
    expect(enabled.models).toEqual(card.models)
    for (const model of customConnectionModels(enabled)) expect(model.serviceTiers).toEqual([{ id: 'priority', name: 'Fast', description: '' }])
    await reopened.save(edit, '')
    expect(reopened.get(card.storageId)?.allowFast).toBe(true)
    await reopened.save({ ...edit, allowFast: false }, '')
    expect(customConnectionModels(reopened.snapshot().connections[0]!)[0]?.serviceTiers).toEqual([])
  })
  it('serves original routing IDs from already saved friendly-name catalogs', () => {
    const rows = customConnectionModels({ model: 'sidux/sol', models: [
      { id: 'sidux/sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: [], serviceTiers: [] },
      { id: 'chatgpt-api/sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: [], serviceTiers: [] },
    ] as never })
    expect(rows.map(row => [row.id, row.model, row.displayName])).toEqual([
      ['sidux/sol', 'sidux/sol', 'sidux/sol'], ['chatgpt-api/sol', 'chatgpt-api/sol', 'chatgpt-api/sol'],
    ])
  })
  it('preserves per-model Magpie efforts and Fast and skips speculative effort probes', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/models') ? { data: [
      { id: 'sidux/sol', supported_reasoning_levels: [{ effort: 'max' }, { effort: 'ultra' }], service_tiers: [{ id: 'priority', name: 'Fast' }] },
      { id: 'sidux/luna', supported_reasoning_levels: [{ effort: 'max' }] },
      { id: 'unknown' },
      { id: 'none', supported_reasoning_levels: [] },
    ] } : { output: [] })))
    const tested = await store.test(draft)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(tested.reasoningEfforts).toEqual(['max', 'ultra'])
    await store.save({ ...draft, model: tested.model }, tested.token)
    const card = store.snapshot().connections[0]!
    expect(card.models.map(row => row.efforts?.map(item => item.value) ?? null)).toEqual([['max', 'ultra'], ['max'], null, []])
    expect(customConnectionModels(card)[0]?.serviceTiers).toEqual([{ id: 'priority', name: 'Fast', description: '' }])
  })

  it('applies fallback probes only to the probed model when declarations are absent', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/models') ? { data: [{ id: 'sample' }, { id: 'other' }, { id: 'none', supported_reasoning_levels: [] }] } : { output: [] })))
    const tested = await store.test(draft)
    await store.save({ ...draft, model: tested.model }, tested.token)
    const models = store.snapshot().connections[0]!.models
    expect(models[0]!.efforts?.map(row => row.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(models[1]!.efforts).toBeNull()
    expect(models[2]!.efforts).toEqual([])
  })

  it('upgrades a legacy capability cache once without generation, runtime rotation or selection changes', async () => {
    const { store, draft, home, fetcher } = await fixture()
    const tested = await store.test(draft)
    await store.save({ ...draft, model: tested.model }, tested.token)
    const raw = JSON.parse(await readFile(join(home, 'custom-connections.json'), 'utf8'))
    delete raw.connections[0].capabilitiesVersion
    raw.connections[0].models[0].efforts = []
    await writeFile(join(home, 'custom-connections.json'), JSON.stringify(raw))
    fetcher.mockClear()
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'sample', supported_reasoning_levels: [{ effort: 'max' }, { effort: 'ultra' }], service_tiers: [{ id: 'priority', name: 'Fast' }] }] })))
    const reopened = new CustomConnectionStore(home, fetcher as typeof fetch)
    const id = raw.connections[0].storageId
    await Promise.all([reopened.refreshModels(id), reopened.refreshModels(id)])
    await reopened.refreshModels(id)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe(draft.baseUrl + '/models')
    const updated = JSON.parse(await readFile(join(home, 'custom-connections.json'), 'utf8'))
    expect(updated.activeId).toBe(raw.activeId)
    expect(updated.connections[0]).toMatchObject({ apiKey: raw.connections[0].apiKey, runtimeToken: raw.connections[0].runtimeToken, revision: raw.connections[0].revision, capabilitiesVersion: 2 })
    expect(reopened.get(id)?.models[0]?.efforts?.map(row => row.value)).toEqual(['max', 'ultra'])
  })
  it('tests real generation, saves redacted cards, and keeps OpenAI credentials and selection unchanged', async () => {
    const { store, draft, home, fetcher } = await fixture()
    const tested = await store.test(draft)
    // models catalog + plain probes for both protocols + one level probe per effort.
    expect(fetcher).toHaveBeenCalledTimes(8)
    expect(tested.models[0]).toMatchObject({ efforts: null, serviceTiers: null, providerId: 'custom' })
    await store.save({ ...draft, model: tested.model }, tested.token)
    const card = store.snapshot().connections[0]
    expect(JSON.stringify(card)).not.toContain('fixture-key')
    expect(card.hasApiKey).toBe(true)
    await store.select(card.storageId)
    const config = customRuntimeConfig(store.active()!, 4190)
    expect(config.args.join(' ')).not.toContain('fixture-key')
    expect(config.args.join(' ')).toContain(`custom_${card.storageId}`)
    expect(config.args.join(' ')).toContain(`/runtime/${card.storageId}/1/v1`)
    await store.select(null)
    expect(store.explicitSelection()).toBe(true)
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('primary-auth')
    expect(await readFile(join(home, 'accounts.json'), 'utf8')).toBe('primary-selection')
    expect((await stat(join(home, 'custom-connections.json'))).mode & 0o777).toBe(0o600)
    const reopened = new CustomConnectionStore(home)
    await reopened.ready
    expect(reopened.snapshot()).toEqual(store.snapshot())
  })
  it('requires a fresh test after any credential edit and supports manual models without a models route', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/models') ? {} : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }), { status: String(url).endsWith('/models') ? 404 : 200 }))
    await expect(store.test(draft)).rejects.toThrow('填写模型名')
    const input = { ...draft, model: 'manual' }
    const tested = await store.test(input)
    await expect(store.save({ ...input, apiKey: 'different-key' }, tested.token)).rejects.toThrow('测试连接')
    await store.save(input, tested.token)
    const card = store.snapshot().connections[0]
    const edited = { ...input, storageId: card.storageId, alias: 'Renamed', apiKey: '' }
    const retest = await store.test(edited)
    await store.save(edited, retest.token)
    expect(store.get(card.storageId)?.apiKey).toBe('fixture-key')
    expect(store.snapshot().connections[0]).toMatchObject({ alias: 'Renamed', revision: 2 })
  })
  it('persists a local model catalog and serves models without an upstream route', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async (url) => new Response(JSON.stringify(String(url).endsWith('/models') ? { error: 'missing' } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }), { status: String(url).endsWith('/models') ? 404 : 200 }))
    const input = { ...draft, model: 'manual', manualModels: ['manual', 'other'] }
    const tested = await store.test(input)
    await store.save(input, tested.token)
    let card = store.snapshot().connections[0]!
    expect(card.supportedEndpoints).toEqual(['/v1/responses'])
    expect(card.manualModels).toEqual(['manual', 'other'])
    expect(customConnectionEndpoints(card)).toEqual(['/v1/responses', '/v1/models'])
    expect(customConnectionManualEndpoints(card)).toEqual(['/v1/models'])
    expect(customConnectionModels(card).map(model => model.id)).toEqual(['manual', 'other'])
    await store.save({ ...input, storageId: card.storageId, apiKey: '', manualModels: normalizeManualModels(['manual', 'second', 'second']) }, '')
    card = store.snapshot().connections[0]!
    expect(card.manualModels).toEqual(['manual', 'second'])
    expect(card.revision).toBe(2)
  })
  it('keeps an edited connection in its list position instead of appending it', async () => {
    const { store, draft } = await fixture()
    const input = (alias: string, baseUrl = draft.baseUrl) => ({ ...draft, alias, baseUrl })
    for (const [alias, baseUrl] of [['First', draft.baseUrl], ['Second', 'https://second.test/v1'], ['Third', 'https://third.test/v1']] as const) {
      const tested = await store.test(input(alias, baseUrl))
      await store.save({ ...input(alias, baseUrl), model: tested.model }, tested.token)
    }
    expect(store.snapshot().connections.map(row => row.alias)).toEqual(['First', 'Second', 'Third'])
    const firstId = store.snapshot().connections[0]!.storageId
    const edit = { ...input('First renamed'), storageId: firstId, apiKey: '' }
    const retest = await store.test(edit)
    await store.save({ ...edit, model: retest.model }, retest.token)
    expect(store.snapshot().connections.map(row => row.alias)).toEqual(['First renamed', 'Second', 'Third'])
    const added = await store.test(input('Fourth', 'https://fourth.test/v1'))
    await store.save({ ...input('Fourth', 'https://fourth.test/v1'), model: added.model }, added.token)
    expect(store.snapshot().connections.map(row => row.alias)).toEqual(['First renamed', 'Second', 'Third', 'Fourth'])
  })

  it('lets bridged chat-only connections serve Codex, and gates unbridged ones out', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/models') ? { data: [{ id: 'sample' }] } : { choices: [{ message: { content: 'hi' } }] })))
    const input = { ...draft, model: 'sample', wireApi: 'chat' as const, protocolBridge: true }
    const tested = await store.test(input)
    expect(tested.wireApi).toBe('chat')
    await store.save(input, tested.token)
    const card = store.snapshot().connections[0]!
    // Bridged chat-only connections are selectable and get a runtime config:
    // Codex keeps wire_api="responses" toward the local route, which the bridge serves.
    await store.select(card.storageId)
    const config = customRuntimeConfig(store.get(card.storageId)!, 4190)
    expect(config.args.join(' ')).toContain(`custom_${card.storageId}`)
    expect(config.args.join(' ')).toContain('/runtime/')
    expect(config.args.join(' ')).toContain('wire_api="responses"')
    expect(store.snapshot().activeId).toBe(card.storageId)

    // Toggling the bridge off must be savable without a fresh probe, and the
    // unbridged connection is refused as a Codex outlet again.
    await store.save({ ...input, storageId: card.storageId, apiKey: '', protocolBridge: false }, '')
    const unbridged = store.snapshot().connections[0]!
    expect(unbridged.protocolBridge).toBe(false)
    expect(store.snapshot().activeId).toBeNull()
    await expect(store.select(unbridged.storageId)).rejects.toThrow('开启协议转换')
    expect(() => customRuntimeConfig(store.get(unbridged.storageId)!, 4190)).toThrow('协议转换')
    // Re-enable without a probe: the toggle round-trips.
    await store.save({ ...input, storageId: card.storageId, apiKey: '', protocolBridge: true }, '')
    expect(store.snapshot().connections[0]).toMatchObject({ protocolBridge: true, revision: 3 })
  })

  it('probes both generation protocols and refreshes saved endpoints when support changes', async () => {
    const { store, draft, fetcher } = await fixture()
    let responses = true
    fetcher.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/models') ? { data: [{ id: 'sample' }] } : String(url).endsWith('/responses') ? responses ? { output: [] } : { error: 'unsupported' } : { choices: [{ message: { content: 'hi' } }] }), { status: String(url).endsWith('/responses') && !responses ? 404 : 200 }))
    const input = { ...draft, model: 'sample' }
    const tested = await store.test(input)
    expect(tested.supportedEndpoints).toEqual(['/v1/models', '/v1/responses', '/v1/chat/completions'])
    await store.save(input, tested.token)
    const id = store.snapshot().connections[0].storageId
    await store.select(id)
    responses = false
    const edit = { ...input, storageId: id, apiKey: '' }
    const retested = await store.test(edit)
    await store.save(edit, retested.token)
    // A previously-Responses connection that loses native support becomes
    // chat-only with the bridge off: it is deselected until the toggle is
    // enabled in its account settings.
    expect(store.snapshot()).toMatchObject({ activeId: null, connections: [{ wireApi: 'chat', protocolBridge: false, supportedEndpoints: ['/v1/models', '/v1/chat/completions'] }] })
  })

  it.each([
    [429, 'Too Many Requests'],
    [402, 'Payment Required'],
    [400, JSON.stringify({ error: { code: 'insufficient_quota', message: 'Quota exhausted' } })],
    [402, JSON.stringify({ error: { message: 'Insufficient account balance' } })],
    [403, JSON.stringify({ error: { code: 'usage_limit_reached' } })],
    [503, JSON.stringify({ error: { type: 'resource_exhausted', message: 'Rate limit reached' } })],
    [200, JSON.stringify({ error: { code: 'insufficient_quota' } })],
    [400, '余额不足，请充值'],
    [403, JSON.stringify({ message: '本周额度已耗尽' })],
  ])('accepts quota responses as supported endpoints and saves the proof: HTTP %s %s', async (status, body) => {
    const { store, draft, fetcher, home } = await fixture()
    fetcher.mockImplementation(async () => new Response(body, { status }))
    const input = { ...draft, model: 'sample' }
    const tested = await store.test(input)
    expect(tested.supportedEndpoints).toEqual(['/v1/models', '/v1/responses', '/v1/chat/completions'])
    expect(tested.wireApi).toBe('responses')
    expect(tested.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(fetcher).toHaveBeenCalledTimes(3)
    await store.save(input, tested.token)
    const card = store.snapshot().connections[0]!
    await store.select(card.storageId)
    const reopened = new CustomConnectionStore(home)
    await reopened.ready
    expect(reopened.snapshot()).toEqual(store.snapshot())
    expect(reopened.active()?.wireApi).toBe('responses')
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('primary-auth')
    expect(await readFile(join(home, 'accounts.json'), 'utf8')).toBe('primary-selection')
  })

  it('keeps Responses support when it is rate limited and Chat succeeds', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async url => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'sample' }] }))
      if (String(url).endsWith('/responses')) return new Response('Rate limit exceeded', { status: 429 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))
    })
    const tested = await store.test(draft)
    expect(tested.supportedEndpoints).toEqual(['/v1/models', '/v1/responses', '/v1/chat/completions'])
    expect(tested.wireApi).toBe('responses')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each(['responses', 'chat'] as const)('accepts a limited %s endpoint while keeping missing endpoints unsupported', async protocol => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async url => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'sample' }] }))
      const supported = String(url).endsWith(protocol === 'chat' ? '/chat/completions' : '/responses')
      return new Response(supported ? 'Too Many Requests' : 'Not Found', { status: supported ? 429 : 404 })
    })
    const tested = await store.test(draft)
    expect(tested.supportedEndpoints).toEqual(['/v1/models', protocol === 'chat' ? '/v1/chat/completions' : '/v1/responses'])
    expect(tested.wireApi).toBe(protocol)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it.each([
    [401, JSON.stringify({ error: { message: 'Authentication required to check quota' } })],
    [403, JSON.stringify({ error: { message: 'No permission to read quota' } })],
    [403, JSON.stringify({ error: { message: 'Insufficient permissions to read quota' } })],
    [403, JSON.stringify({ error: { code: 'invalid_api_key', message: 'Check your quota; insufficient balance' } })],
    [404, JSON.stringify({ error: { message: 'Quota endpoint not found' } })],
    [405, 'Method Not Allowed'],
    [400, JSON.stringify({ error: { message: 'Unknown model; check your quota settings' } })],
    [500, 'Internal Server Error'],
    [200, JSON.stringify({ message: 'remaining quota is 100' })],
  ])('does not turn unrelated failures into successful tests: HTTP %s %s', async (status, body) => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async () => new Response(body, { status }))
    await expect(store.test({ ...draft, model: 'sample' })).rejects.toThrow('连接测试失败')
    expect(store.snapshot().connections).toEqual([])
  })

  it('still asks for a model when the model catalog is rate limited', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async () => new Response('Too Many Requests', { status: 429 }))
    await expect(store.test(draft)).rejects.toThrow('填写模型名')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([429, 402])('keeps effort levels when a quota error names reasoning: HTTP %s', async status => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async (url, options?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'sample' }] }))
      const body = JSON.parse(String(options?.body || '{}'))
      if (body.reasoning) return new Response(JSON.stringify({ error: { message: 'Insufficient quota for reasoning effort' } }), { status })
      return new Response(JSON.stringify({ output: [] }))
    })
    const tested = await store.test(draft)
    expect(tested.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(fetcher).toHaveBeenCalledTimes(8)
  })

  it('probes every effort level and drops only the levels the upstream rejects by name', async () => {
    const { store, draft, fetcher } = await fixture()
    fetcher.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const target = String(url)
      const body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>
      if (target.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'sample' }] }))
      if (target.endsWith('/responses')) return new Response('not found', { status: 404 })
      // Strict value validation: the parameter itself is accepted, but xhigh
      // is rejected by name; every other level serves normally.
      if ('reasoning_effort' in body && body.reasoning_effort === 'xhigh') return new Response(JSON.stringify({ error: { message: "invalid reasoning_effort: 'xhigh'" } }), { status: 400 })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }))
    })
    const input = { ...draft, model: 'sample' }
    const tested = await store.test(input)
    expect(tested.wireApi).toBe('chat')
    expect(tested.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high'])
    await store.save(input, tested.token)
    const card = store.snapshot().connections[0]!
    expect(card.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(card.models[0].efforts?.map(item => item.value)).toEqual(['minimal', 'low', 'medium', 'high'])
    // A no-probe save keeps the previous verdicts — only a re-test refreshes them.
    await store.save({ ...input, storageId: card.storageId, apiKey: '', protocolBridge: true }, '')
    const edited = store.snapshot().connections[0]!
    expect(edited.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(edited.revision).toBe(2)
  })

  it('keeps all levels when the upstream accepts the parameter or the probe is inconclusive', async () => {
    const { store, draft, fetcher, home } = await fixture()
    // Accepted: every level probe returns a normal chat completion.
    fetcher.mockImplementation(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'sample' }] }))
      if (target.endsWith('/responses')) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }))
    })
    const input = { ...draft, model: 'sample' }
    const accepted = await store.test(input)
    expect(accepted.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    await store.save(input, accepted.token)
    expect(store.snapshot().connections[0]!.models[0].efforts?.map(item => item.value)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])

    // Inconclusive: a level probe fails for an unrelated reason (no parameter
    // named), so the level stays supported by default.
    fetcher.mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      const target = String(url)
      const body = JSON.parse(String(options?.body || '{}')) as Record<string, unknown>
      if (target.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'sample' }] }))
      if (target.endsWith('/responses')) return new Response('not found', { status: 404 })
      if ('reasoning_effort' in body) return new Response(JSON.stringify({ error: { message: 'insufficient quota' } }), { status: 400 })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }))
    })
    const retested = await store.test({ ...input, storageId: store.snapshot().connections[0]!.storageId, apiKey: '' })
    expect(retested.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    // The persisted list round-trips through a reopened store.
    const reopened = new CustomConnectionStore(home)
    await reopened.ready
    expect(reopened.snapshot().connections[0]?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

})

  it('shares connection identity with an execution bridge retained across module reloads', async () => {
  const { home } = await fixture()
  const firstModule = await import('./customConnectionStore')
  const store = firstModule.getCustomConnectionStore(home)
  await store.ready
  vi.resetModules()
  const reloaded = await import('./customConnectionStore')
  expect(reloaded.getCustomConnectionStore(home)).toBe(store)
})
