import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { AccountAuthStore } from '../accountAuthStore'
import { AccountAuthCoordinator } from '../accountAuthCoordinator'
import { getCustomConnectionStore } from '../customConnectionStore'
import { ApiProxyGateway } from './gateway'

it('routes two external keys independently, retains usage and never prepares OpenAI credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'custom-api-'))
  const seen: Array<{ key: string; url: string; body: any }> = []
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/models') { res.end(JSON.stringify({ data: [{ id: 'sample' }] })); return }
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    const key = req.headers.authorization || ''
    seen.push({ key, url: req.url || '', body })
    if ((req.url || '').endsWith('/responses')) {
      // Connections a/b are chat-only; their Responses probe must fail.
      if (key === 'Bearer fixture-a' || key === 'Bearer fixture-b') {
        res.writeHead(404)
        res.end(JSON.stringify({ error: { message: 'no responses endpoint' } }))
        return
      }
      res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', model: 'sample', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: key === 'Bearer fixture-c' ? 'C' : 'X' }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }))
      return
    }
    // Connection c is Responses-only; its Chat probe must fail.
    if ((req.url || '').endsWith('/chat/completions') && key === 'Bearer fixture-c') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: { message: 'no chat endpoint' } }))
      return
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: key === 'Bearer fixture-a' ? 'A' : 'B' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}`
  const coordinator = new AccountAuthCoordinator(new AccountAuthStore(home))
  const credential = vi.spyOn(coordinator, 'getApiCredential').mockRejectedValue(new Error('OpenAI credential access forbidden in this test'))
  const gateway = new ApiProxyGateway(coordinator)
  const front = createServer((req, res) => { void gateway.handleApi(req, res) })
  try {
    await gateway.store.ready
    const connections = getCustomConnectionStore(home)
    for (const alias of ['a', 'b']) {
      const draft = { alias, provider: 'custom', baseUrl, apiKey: `fixture-${alias}`, model: 'sample', wireApi: 'chat' as const, protocolBridge: true }
      const tested = await connections.test(draft)
      expect(tested.wireApi).toBe('chat')
      await connections.save(draft, tested.token)
    }
    const cDraft = { alias: 'c', provider: 'custom', baseUrl, apiKey: 'fixture-c', model: 'sample', wireApi: 'responses' as const, protocolBridge: true }
    const cTested = await connections.test(cDraft)
    expect(cTested.wireApi).toBe('responses')
    expect(cTested.supportedEndpoints).toEqual(['/v1/models', '/v1/responses'])
    await connections.save(cDraft, cTested.token)
    const [a, b] = connections.snapshot().connections
    await connections.select(a.storageId)
    await gateway.store.saveSettings({ ...gateway.store.settings, enabled: true })
    const ka = await gateway.store.createKey('A', null, { accountStorageId: a.storageId })
    const kb = await gateway.store.createKey('B', null, { accountStorageId: b.storageId })
    const kc = await gateway.store.createKey('C', null, { accountStorageId: connections.snapshot().connections[2]!.storageId })
    front.listen(0, '127.0.0.1')
    await once(front, 'listening')
    const url = `http://127.0.0.1:${(front.address() as any).port}`
    const request = (key: string, path: string) => fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'sample', input: 'hi', messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'high' }, service_tier: 'priority', stream: false }) }).then(res => res.json())
    const [ra, rb] = await Promise.all([request(ka.secret, '/v1/chat/completions'), request(kb.secret, '/v1/chat/completions')])
    expect(ra.choices[0].message.content).toBe('A')
    expect(rb.choices[0].message.content).toBe('B')
    await connections.select(b.storageId)
    expect((await request(ka.secret, '/v1/chat/completions')).choices[0].message.content).toBe('A')
    expect(seen.slice(-3).map(row => row.key).sort()).toEqual(['Bearer fixture-a', 'Bearer fixture-a', 'Bearer fixture-b'])
    // The level probes served normally, so the connections declare efforts and
    // client reasoning params pass through; service_tier is still stripped
    // because the catalog declares no tiers.
    expect(seen.slice(-3).every(row => !row.body.service_tier && row.body.reasoning?.effort === 'high')).toBe(true)
    // /v1/responses on a bridged chat-only connection goes through the
    // protocol bridge; /v1/responses/compact stays unsupported.
    const beforeUnsupported = seen.length
    const bridged = await request(ka.secret, '/v1/responses')
    expect(bridged.object).toBe('response')
    expect(bridged.choices).toBeUndefined()
    expect(bridged.output[0].content[0].text).toBe('A')
    // The bridge forwarded a converted Chat Completions payload upstream.
    expect(seen.at(-1)!.body.input).toBeUndefined()
    expect(seen.at(-1)!.body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(seen.at(-1)!.body.stream).toBe(false)
    const denied = await request(ka.secret, '/v1/responses/compact')
    expect(denied.error.code).toBe('unsupported_endpoint')
    expect(seen.length).toBe(beforeUnsupported + 1)
    // Reverse bridge: a Responses-only connection serves /v1/chat/completions
    // by converting to a Responses request upstream.
    const reverseBridged = await request(kc.secret, '/v1/chat/completions')
    expect(reverseBridged.choices[0].message.content).toBe('C')
    expect(seen.at(-1)!.url.endsWith('/responses')).toBe(true)
    expect(seen.at(-1)!.body.input[0].type).toBe('message')
    expect(credential).not.toHaveBeenCalled()
    expect(gateway.activity.entries.size).toBe(0)
    expect(gateway.usage.summary().keys[ka.key.id].cumulative).toMatchObject({ requests: 4, total: 9, completed: 3 })
    await expect(readFile(join(home, 'auth.json'))).rejects.toThrow()
    expect((await coordinator.store.readState()).activeStorageId).toBeNull()
  } finally {
    front.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => front.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
    await gateway.close()
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
