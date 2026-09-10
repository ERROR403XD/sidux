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
  const seen: Array<{ key: string; body: any }> = []
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/models') { res.end(JSON.stringify({ data: [{ id: 'sample' }] })); return }
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    seen.push({ key: req.headers.authorization || '', body })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: req.headers.authorization === 'Bearer fixture-a' ? 'A' : 'B' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }))
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
      const draft = { alias, provider: 'custom', baseUrl, apiKey: `fixture-${alias}`, model: 'sample', wireApi: 'chat' as const }
      const tested = await connections.test(draft)
      await connections.save(draft, tested.token)
    }
    const [a, b] = connections.snapshot().connections
    await expect(connections.select(a.storageId)).rejects.toThrow('Chat Completions')
    await gateway.store.saveSettings({ ...gateway.store.settings, enabled: true })
    const ka = await gateway.store.createKey('A', null, { accountStorageId: a.storageId })
    const kb = await gateway.store.createKey('B', null, { accountStorageId: b.storageId })
    front.listen(0, '127.0.0.1')
    await once(front, 'listening')
    const url = `http://127.0.0.1:${(front.address() as any).port}`
    const request = (key: string, path: string) => fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'sample', input: 'hi', messages: [{ role: 'user', content: 'hi' }], reasoning: { effort: 'high' }, service_tier: 'priority', stream: false }) }).then(res => res.json())
    const [ra, rb] = await Promise.all([request(ka.secret, '/v1/chat/completions'), request(kb.secret, '/v1/chat/completions')])
    expect(ra.choices[0].message.content).toBe('A')
    expect(rb.choices[0].message.content).toBe('B')
    await expect(connections.select(b.storageId)).rejects.toThrow('Chat Completions')
    expect((await request(ka.secret, '/v1/chat/completions')).choices[0].message.content).toBe('A')
    expect(seen.slice(-3).map(row => row.key).sort()).toEqual(['Bearer fixture-a', 'Bearer fixture-a', 'Bearer fixture-b'])
    expect(seen.slice(-3).every(row => !row.body.reasoning && !row.body.reasoning_effort && !row.body.service_tier)).toBe(true)
    const beforeUnsupported = seen.length
    for (const path of ['/v1/responses', '/v1/responses/compact']) {
      const denied = await request(ka.secret, path)
      expect(denied.error.code).toBe('unsupported_endpoint')
    }
    expect(seen.length).toBe(beforeUnsupported)
    expect(credential).not.toHaveBeenCalled()
    expect(gateway.activity.entries.size).toBe(0)
    expect(gateway.usage.summary().keys[ka.key.id].cumulative).toMatchObject({ requests: 4, total: 6, completed: 2 })
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
