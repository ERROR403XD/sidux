import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('tests real generation, saves redacted cards, and keeps OpenAI credentials and selection unchanged', async () => {
    const { store, draft, home, fetcher } = await fixture()
    const tested = await store.test(draft)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(tested.models[0]).toMatchObject({ efforts: [], serviceTiers: [], providerId: 'custom' })
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
