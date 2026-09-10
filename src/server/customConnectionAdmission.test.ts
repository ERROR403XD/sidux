import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { getAccountAuthCoordinator } from './accountAuthCoordinator'
import { getCustomConnectionStore } from './customConnectionStore'

it('tests and adds a connection during an OpenAI quota refresh without changing either account selection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'custom-admission-'))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const coordinator = getAccountAuthCoordinator()
  const credential = JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'primary-A', refresh_token: 'fixture-refresh',
    access_token: `header.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'primary-A', user_id: 'fixture' } })).toString('base64url')}.fixture`,
  } })
  const primary = await coordinator.store.upsertCredential(credential, { activate: true })
  const before = await readFile(join(home, 'auth.json'), 'utf8')
  const middleware = createCodexBridgeMiddleware()
  let probes = 0
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/fixture/')) {
      probes++
      const data = request.url.endsWith('/models') ? { data: [{ id: 'sample' }] }
        : request.url.endsWith('/responses') ? { output: [{ type: 'message' }], status: 'completed' }
          : { choices: [{ message: { content: 'hi' } }] }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(data))
      return
    }
    void middleware(request, response, () => { response.writeHead(404).end() })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not start')
  const base = `http://127.0.0.1:${address.port}`
  let releaseRefresh!: () => void
  const refreshPending = new Promise<void>(done => { releaseRefresh = done })
  const previousReader = coordinator.runtimeQuotaReader
  coordinator.runtimeQuotaReader = async () => {
    await refreshPending
    return primary.account
  }
  const refresh = coordinator.refreshAccount(primary.account.storageId)
  async function post(path: string, body: unknown) {
    const response = await fetch(`${base}/codex-api/custom-connections${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    await vi.waitFor(() => expect(coordinator.isAccountOperationInProgress()).toBe(true))
    expect(coordinator.blocksNewSubmissions()).toBe(false)
    const draft = { alias: 'Independent config', provider: 'custom', baseUrl: `${base}/fixture/v1`, model: '', apiKey: 'fixture-external-key', wireApi: 'responses' }
    const tested = await post('/test', draft)
    expect(tested.status).toBe(200)
    expect(tested.body.data.supportedEndpoints).toHaveLength(3)
    const saved = await post('', { ...draft, model: tested.body.data.model, testToken: tested.body.data.token })
    expect(saved.status).toBe(200)
    expect(saved.body.data.connections).toHaveLength(1)
    expect(saved.body.data.activeId).toBeNull()
    expect(probes).toBe(3)
    expect(coordinator.isAccountOperationInProgress()).toBe(true)
    expect((await coordinator.store.readState()).activeStorageId).toBe(primary.account.storageId)
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(before)
    const stored = JSON.parse(await readFile(join(home, 'custom-connections.json'), 'utf8'))
    expect(stored.connections[0].alias).toBe('Independent config')
    // Selecting a provider still uses the existing admission gate.
    const selection = await post('/select', { storageId: saved.body.data.connections[0].storageId })
    expect(selection.status).toBe(400)
    expect(getCustomConnectionStore().active()).toBeUndefined()
  } finally {
    releaseRefresh()
    await refresh
    coordinator.runtimeQuotaReader = previousReader
    await middleware.dispose()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 15000)
