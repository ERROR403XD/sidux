import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMediaRoutes } from './mediaRoutes.js'
import { setJson } from '../httpUtils.js'

const nativeFetch = globalThis.fetch
let home: string
let server: Server
let upstream: Server
let base: string
let upstreamBase: string
let uploads: string[]
let logoStatus: number
let logoJson: unknown
let logoType: string
let logoBytes: Buffer
let requests: Array<{ url: string; headers: Record<string, unknown> }>

async function listen(instance: Server) {
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-media-'))
  vi.stubEnv('CODEX_HOME', home)
  uploads = []
  requests = []
  logoStatus = 200
  logoJson = null
  logoType = 'image/svg+xml'
  logoBytes = Buffer.from('fixture-image')
  upstream = createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers })
    if (logoJson !== null) return setJson(res, logoStatus, logoJson)
    res.writeHead(logoStatus, logoType ? { 'Content-Type': logoType } : {})
    res.end(logoBytes)
  })
  upstreamBase = await listen(upstream)
  vi.stubGlobal('fetch', (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('https://chatgpt.com/backend-api/aip/connectors/')) throw new Error('Unexpected external request')
    return nativeFetch(`${upstreamBase}${new URL(url).pathname}${new URL(url).search}`, options)
  })
  const routes = createMediaRoutes()
  server = createServer((req, res) => {
    void routes(req, res, new URL(req.url ?? '/', 'http://localhost')).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unhandled' })
    }).catch(error => setJson(res, 502, { error: error.message }))
  })
  base = await listen(server)
})

afterEach(async () => {
  for (const instance of [server, upstream]) {
    instance.closeAllConnections()
    await new Promise<void>(resolve => instance.close(() => resolve()))
  }
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const path of uploads) await rm(dirname(path), { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function auth() {
  await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-access', account_id: 'synthetic-account' } }))
}

async function logo(src = 'connectors://fixture/id?theme=dark') {
  return nativeFetch(`${base}/codex-api/connector-logo?src=${encodeURIComponent(src)}`)
}

describe('media HTTP/file/auth/logo contracts', () => {
  it('stores the first multipart file byte-for-byte in a unique directory with a normalized name', async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 42, 99])
    const boundary = 'sidux-fixture'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nignored\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="dir\\sub/file.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await nativeFetch(`${base}/codex-api/upload-file`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body })
      expect(response.status).toBe(200)
      const { path } = await response.json() as { path: string }
      expect(dirname(dirname(path))).toBe(join(tmpdir(), 'codex-web-uploads'))
      uploads.push(path)
      expect(basename(path)).toBe('dir_sub_file.bin')
      expect(await readFile(path)).toEqual(bytes)
    }
    expect(dirname(uploads[0]!)).not.toBe(dirname(uploads[1]!))
  })

  it('keeps missing-boundary/no-file errors and denies transcription before consuming a body', async () => {
    const missing = await nativeFetch(`${base}/codex-api/upload-file`, { method: 'POST', body: 'fixture' })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'Missing multipart boundary' })
    const noFile = await nativeFetch(`${base}/codex-api/upload-file`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: '--x\r\nContent-Disposition: form-data; name="field"\r\n\r\ndata\r\n--x--\r\n' })
    expect(noFile.status).toBe(400)
    expect(await noFile.json()).toEqual({ error: 'No file in request' })
    for (const invalid of [null, '{malformed']) {
      if (invalid) await writeFile(join(home, 'auth.json'), invalid)
      const response = await nativeFetch(`${base}/codex-api/transcribe`, { method: 'POST', body: 'not audio' })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'No auth token available for transcription' })
    }
    expect(requests).toHaveLength(0)
  })

  it('uses the auth/account identity once and preserves raw image headers and HTTP cache policy', async () => {
    await auth()
    const response = await logo(' connectors://fixture/id?theme=DARK#fragment ')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(logoBytes)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: '/backend-api/aip/connectors/fixture/logo?theme=dark', headers: { authorization: 'Bearer synthetic-access', 'chatgpt-account-id': 'synthetic-account', originator: 'Codex Desktop' } })
  })

  it.each(['contentType', 'content_type'])('decodes the %s JSON/base64 image envelope', async key => {
    await auth()
    logoJson = { body: { base64: logoBytes.toString('base64'), [key]: 'image/webp' } }
    const response = await logo('connectors://encoded%2Fid?theme=unknown')
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(logoBytes)
    expect(requests[0]!.url).toBe('/backend-api/aip/connectors/encoded%252Fid/logo?theme=light')
  })

  it('uses the snake-case fallback for blank canonical types and preserves canonical precedence', async () => {
    await auth()
    for (const contentType of ['', '   ', 'image/svg+xml']) {
      logoJson = { body: { base64: logoBytes.toString('base64'), contentType, content_type: 'image/webp' } }
      const response = await logo()
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(contentType.trim() || 'image/webp')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(logoBytes)
    }
    expect(requests).toHaveLength(3)
  })

  it('keeps missing URL/auth, malformed envelope and upstream failure mappings', async () => {
    const missing = await logo('')
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'Missing src' })
    const bad = await logo('https://example.test/logo')
    expect(bad.status).toBe(502)
    expect(await bad.json()).toEqual({ error: 'Unsupported connector logo URL' })
    const noAuth = await logo()
    expect(noAuth.status).toBe(502)
    expect(await noAuth.json()).toEqual({ error: 'No auth token available for connector logo' })
    expect(requests).toHaveLength(0)
    await auth()
    logoJson = { body: { base64: 'Zm9v' } }
    expect(await (await logo()).json()).toEqual({ error: 'Connector logo response was missing image data' })
    logoStatus = 403
    const failure = await logo()
    expect(failure.status).toBe(502)
    expect(await failure.json()).toEqual({ error: 'Connector logo fetch failed (403)' })
    expect(requests).toHaveLength(2)
  })

  it('defaults a raw logo without a content type to PNG and falls through unrelated methods', async () => {
    await auth()
    logoType = ''
    const response = await logo()
    expect(response.headers.get('content-type')).toBe('image/png')
    expect((await nativeFetch(`${base}/codex-api/upload-file`)).status).toBe(404)
    expect((await nativeFetch(`${base}/codex-api/connector-logo`, { method: 'POST' })).status).toBe(404)
  })
})
