import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readRawBody, setJson } from './httpUtils.js'

vi.mock('node:https', async importOriginal => ({
  ...await importOriginal<typeof import('node:https')>(),
  request: (url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    if (url !== 'https://chatgpt.com/backend-api/transcribe') throw new Error('Unexpected external request')
    return httpRequest(`${upstreamBase}/transcribe`, options, callback)
  },
}))

let home: string
let toolDir: string
let base: string
let upstreamBase: string
let servers: Server[]
let nativeStatus: number
let nativeBody: string
let nativeCalls: Array<{ body: string; headers: Record<string, unknown> }>

async function listen(instance: Server) {
  servers.push(instance)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`
}

beforeEach(async () => {
  vi.resetModules()
  home = await mkdtemp(join(tmpdir(), 'sidux-transcribe-'))
  toolDir = join(home, 'tools')
  await mkdir(toolDir)
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('PATH', toolDir)
  vi.stubEnv('SIDUX_TRANSCRIBE_FIXTURE_HOME', home)
  vi.stubEnv('SIDUX_TRANSCRIBE_FIXTURE_REPLY', JSON.stringify({ status: 201, body: '{"text":"curl-fixture"}' }))
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-access', account_id: 'synthetic-account' } }))
  servers = []
  nativeCalls = []
  nativeStatus = 202
  nativeBody = '{"text":"native-fixture"}'
  upstreamBase = await listen(createServer((req, res) => {
    void readRawBody(req).then(body => {
      nativeCalls.push({ body: body.toString('base64'), headers: req.headers })
      res.writeHead(nativeStatus, { 'Content-Type': 'application/json' })
      res.end(nativeBody)
    })
  }))
  const { createMediaRoutes } = await import('./routes/mediaRoutes.js')
  const route = createMediaRoutes()
  base = await listen(createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost')).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unhandled' })
    }).catch(error => setJson(res, 502, { error: error.message }))
  }))
})

afterEach(async () => {
  for (const instance of servers.reverse()) {
    instance.closeAllConnections()
    await new Promise<void>(resolve => instance.close(() => resolve()))
  }
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function installCurl() {
  const file = join(toolDir, 'curl-impersonate-chrome')
  await writeFile(file, `#!${process.execPath}
const fs = require('node:fs')
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.SIDUX_TRANSCRIBE_FIXTURE_HOME + '/curl-calls.jsonl', JSON.stringify({ args: process.argv.slice(2), body: Buffer.concat(chunks).toString('base64'), impersonate: process.env.CURL_IMPERSONATE }) + '\\n')
  const reply = JSON.parse(process.env.SIDUX_TRANSCRIBE_FIXTURE_REPLY)
  process.stdout.write(reply.body + '\\n' + reply.status)
})
`)
  await chmod(file, 0o700)
}

const audio = Buffer.from([0, 128, 255, 13, 10, 77])
async function transcribe(contentType = 'audio/fixture') {
  const response = await fetch(`${base}/codex-api/transcribe`, { method: 'POST', headers: { 'Content-Type': contentType }, body: audio, signal: AbortSignal.timeout(5000) })
  return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() }
}

describe('transcription auth/body/transport/fallback contracts', () => {
  it('falls back from a missing curl executable to one real HTTP request with exact bytes and identity', async () => {
    expect(await transcribe()).toEqual({ status: 202, contentType: 'application/json; charset=utf-8', body: nativeBody })
    expect(nativeCalls).toHaveLength(1)
    expect(nativeCalls[0]).toMatchObject({ body: audio.toString('base64'), headers: {
      authorization: 'Bearer synthetic-access', 'chatgpt-account-id': 'synthetic-account', 'content-length': String(audio.length), 'content-type': 'audio/fixture', originator: 'Codex Desktop',
    } })
    expect(await transcribe()).toMatchObject({ status: 202 })
    expect(nativeCalls).toHaveLength(2)
  })

  it.skipIf(process.platform === 'win32')('uses a real synthetic curl process and forwards its status/body without duplicate HTTP', async () => {
    await installCurl()
    expect(await transcribe()).toEqual({ status: 201, contentType: 'application/json; charset=utf-8', body: '{"text":"curl-fixture"}' })
    const calls = (await readFile(join(home, 'curl-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ body: audio.toString('base64'), impersonate: 'chrome116' })
    expect(calls[0].args).toEqual(expect.arrayContaining(['https://chatgpt.com/backend-api/transcribe', 'Content-Type: audio/fixture', 'Authorization: Bearer synthetic-access', 'ChatGPT-Account-Id: synthetic-account', '--data-binary', '@-']))
    expect(calls[0].args.join(' ')).not.toContain('Content-Length')
    expect(nativeCalls).toHaveLength(0)
  })

  it.skipIf(process.platform === 'win32')('keeps failed spawn unavailable when its later close event fires across route instances', async () => {
    expect((await transcribe()).status).toBe(202)
    await installCurl()
    const { createMediaRoutes } = await import('./routes/mediaRoutes.js')
    const secondRoute = createMediaRoutes()
    base = await listen(createServer((req, res) => {
      void secondRoute(req, res, new URL(req.url ?? '/', 'http://localhost')).catch(error => setJson(res, 502, { error: error.message }))
    }))
    expect((await transcribe()).status).toBe(202)
    expect(nativeCalls).toHaveLength(2)
    await expect(readFile(join(home, 'curl-calls.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('keeps Cloudflare challenge mapping and ordinary provider errors', async () => {
    await installCurl()
    vi.stubEnv('SIDUX_TRANSCRIBE_FIXTURE_REPLY', JSON.stringify({ status: 403, body: 'cf_chl fixture' }))
    expect(await transcribe()).toMatchObject({ status: 503, body: JSON.stringify({ error: 'Transcription blocked by Cloudflare. Install curl-impersonate-chrome.' }) })
    vi.stubEnv('SIDUX_TRANSCRIBE_FIXTURE_REPLY', JSON.stringify({ status: 429, body: '{"error":"fixture quota"}' }))
    expect(await transcribe()).toMatchObject({ status: 429, body: '{"error":"fixture quota"}' })
    expect(nativeCalls).toHaveLength(0)
  })
})
