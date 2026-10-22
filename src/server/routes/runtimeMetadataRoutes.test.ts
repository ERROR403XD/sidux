import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppServerProcess } from '../appServerProcess.js'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { MethodCatalog } from '../runtimeCapabilities.js'
import { createRuntimeMetadataService } from '../runtimeMetadataService.js'
import { createRuntimeMetadataRoutes } from './runtimeMetadataRoutes.js'

let fixtureCliPath: string
vi.mock('../../commandResolution.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../commandResolution.js')>(),
  resolveCodexCommand: () => fixtureCliPath,
}))

let home: string
let server: Server
let base: string
let runtime: AppServerProcess
let catalog: MethodCatalog

// The fixture executable exercises real spawn/schema files without native auth.
describe.skipIf(process.platform === 'win32')('runtime metadata HTTP and real resource owners', () => {
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sidux-runtime-metadata-'))
    fixtureCliPath = join(home, 'codex-fixture.cjs')
    await writeFile(fixtureCliPath, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, 'commands.jsonl'), JSON.stringify(args) + '\\n')
if (args[0] === '--version') {
  console.log('fixture-cli 1.0')
} else {
  const dir = args[args.indexOf('--out') + 1]
  if (fs.existsSync(path.join(__dirname, 'fail'))) process.exit(1)
  fs.mkdirSync(path.join(dir, 'v2'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ClientRequest.json'), JSON.stringify({ oneOf: ['thread/turns/list', 'thread/items/list'].map(method => ({ properties: { method: { const: method } } })) }))
  fs.writeFileSync(path.join(dir, 'ServerNotification.json'), JSON.stringify({ oneOf: [{ properties: { method: { enum: ['turn/completed'] } } }] }))
  fs.writeFileSync(path.join(dir, 'v2', 'ThreadResumeParams.json'), JSON.stringify({ properties: { initialTurnsPage: {} } }))
  fs.writeFileSync(path.join(dir, 'v2', 'ThreadForkParams.json'), JSON.stringify({ properties: { lastTurnId: {}, deferGoalContinuation: {} } }))
}
`)
    await chmod(fixtureCliPath, 0o700)
    runtime = new AppServerProcess({ isolatedTask: true })
    catalog = new MethodCatalog()
    const route = createRuntimeMetadataRoutes(createRuntimeMetadataService({
      appVersion: '0.2.22-test', runtime, catalog,
      readAuthRecovery: () => runtime.authRecovery.snapshot(),
    }))
    server = createServer((req, res) => {
      void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody })
        .then(handled => { if (!handled) setJson(res, 404, { error: 'Unknown route' }) })
        .catch(error => setJson(res, 502, { error: error.message }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing listener')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await runtime.dispose()
    vi.restoreAllMocks()
    await rm(home, { recursive: true, force: true })
  })

  async function get(path: string) {
    const response = await fetch(`${base}/codex-api/${path}`)
    return { status: response.status, body: await response.json() as any }
  }

  async function respond(payload: unknown) {
    const response = await fetch(`${base}/codex-api/server-requests/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    return { status: response.status, body: await response.json() as any }
  }

  it('coalesces cold capability generation and reuses the catalog for methods/notifications', async () => {
    const [first, second] = await Promise.all([get('meta/capabilities'), get('meta/capabilities')])
    expect(first).toEqual(second)
    expect(first.body.data).toMatchObject({ appVersion: '0.2.22-test', cliVersion: 'fixture-cli 1.0', features: { historyPaging: true, resumeInitialPage: true, exactFork: true } })
    expect((await get('meta/methods')).body.data).toEqual(['thread/items/list', 'thread/turns/list'])
    expect((await get('meta/notifications')).body.data).toEqual(['turn/completed'])
    const commands = (await readFile(join(home, 'commands.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row))
    expect(commands.filter(args => args[0] === '--version')).toHaveLength(1)
    expect(commands.filter(args => args[0] === 'app-server')).toHaveLength(1)
    for (const args of commands.filter(args => args[0] === 'app-server')) {
      await expect(readFile(join(args.at(-1), 'ClientRequest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('evicts failed generation for retry and detects changed executable metadata', async () => {
    await writeFile(join(home, 'fail'), '')
    expect((await get('meta/capabilities')).status).toBe(502)
    await rm(join(home, 'fail'))
    expect((await get('meta/capabilities')).body.data.cliVersion).toBe('fixture-cli 1.0')
    const script = await readFile(fixtureCliPath, 'utf8')
    await writeFile(fixtureCliPath, script.replace('fixture-cli 1.0', 'fixture-cli 2.0-new'))
    expect((await get('meta/capabilities')).body.data.cliVersion).toBe('fixture-cli 2.0-new')
  })

  it('keeps pending requests and auth recovery live without RPC or metadata generation', async () => {
    const rpc = vi.spyOn(runtime, 'rpc')
    runtime.authRecovery.observe('modelProvider/authRecoveryStarted', { threadId: 'a', turnId: 't', message: 'retry' })
    expect((await get('server-requests/pending')).body).toMatchObject({ data: [], authRecovery: [{ threadId: 'a', phase: 'started' }] })
    runtime.authRecovery.observe('turn/completed', { threadId: 'a', turn: { id: 't' } })
    expect((await get('server-requests/pending')).body).toEqual({ data: [], authRecovery: [] })
    expect((await get('worker-pools')).body.data).toEqual(runtime.workerPoolDiagnostics())
    expect((await get('home-directory')).body).toEqual({ data: { path: homedir() } })
    expect(rpc).not.toHaveBeenCalled()
    await expect(readFile(join(home, 'commands.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses runtime validation and resolves a native pending request exactly once', async () => {
    expect((await respond(null)).body.error).toContain('expected object')
    expect((await respond({ id: 1.5, result: {} })).body.error).toContain('integer')
    // Only native initialization and JSON-RPC writes are replaced here.
    const native = runtime as any
    vi.spyOn(native, 'ensureInitialized').mockResolvedValue(undefined)
    const sendLine = vi.spyOn(native, 'sendLine').mockImplementation(() => {})
    native.pendingServerRequests.set(7, { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'a' } })
    expect((await get('server-requests/pending')).body.data).toHaveLength(1)
    expect(await respond({ id: 7, result: { decision: 'accept' } })).toEqual({ status: 200, body: { ok: true } })
    expect(sendLine).toHaveBeenCalledExactlyOnceWith({ jsonrpc: '2.0', id: 7, result: { decision: 'accept' } })
    expect((await get('server-requests/pending')).body.data).toEqual([])
    expect((await respond({ id: 7, result: {} })).status).toBe(502)
    expect(sendLine).toHaveBeenCalledTimes(1)
    expect((await get('unknown')).status).toBe(404)
  })
})
