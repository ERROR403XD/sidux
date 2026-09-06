import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { createFrontendAssetsMiddleware, sendFrontendEntry } from './frontendAssets'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codexapp-cache-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const entry = join(directory, 'index.html')
  const date = new Date(499162500000)
  async function writeEntry(text: string) {
    await writeFile(entry, text)
    await utimes(entry, date, date)
  }
  await writeEntry('<html>old</html>')
  await mkdir(join(directory, 'assets'))
  await writeFile(join(directory, 'assets/index-abcdefgh.js'), 'export default 1')
  await writeFile(join(directory, 'sw.js'), '/* worker */')
  const app = express()
  let legacy = false
  const oldStatic = express.static(directory)
  app.use((req, res, next) => legacy ? oldStatic(req, res, next) : next())
  app.use(createFrontendAssetsMiddleware(directory))
  app.use((_req, res) => sendFrontendEntry(res, entry))
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  cleanups.push(() => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  const address = server.address() as { port: number }
  return { base: `http://127.0.0.1:${address.port}`, writeEntry, setLegacy(value: boolean) { legacy = value } }
}

describe('frontend release cache migration', () => {
  it('does not accept an old metadata validator for equal-size, equal-mtime new HTML', async () => {
    const f = await fixture()
    f.setLegacy(true)
    const old = await fetch(f.base)
    const etag = old.headers.get('etag')!
    const modified = old.headers.get('last-modified')!
    expect(etag).toBeTruthy()
    expect(await old.text()).toBe('<html>old</html>')
    await f.writeEntry('<html>new</html>')
    f.setLegacy(false)
    for (const path of ['/', '/index.html', '/a/page']) {
      const response = await fetch(f.base + path, { headers: { 'If-None-Match': etag, 'If-Modified-Since': modified } })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('etag')).toBeNull()
      expect(response.headers.get('last-modified')).toBeNull()
      expect(await response.text()).toBe('<html>new</html>')
    }
  })

  it('keeps content-hashed assets cacheable and fixed URLs fresh', async () => {
    const f = await fixture()
    const asset = await fetch(f.base + '/assets/index-abcdefgh.js')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toContain('javascript')
    const worker = await fetch(f.base + '/sw.js')
    expect(worker.headers.get('cache-control')).toBe('no-store')
    expect(worker.headers.get('etag')).toBeNull()
  })

  it('never sends the SPA entry for missing files or unknown API requests', async () => {
    const f = await fixture()
    for (const path of ['/assets/old-chunk.js', '/missing.css', '/icons/missing.png', '/codex-api/unknown']) {
      const response = await fetch(f.base + path)
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-type')).toContain('text/plain')
      expect(await response.text()).not.toContain('<html>')
    }
    expect((await fetch(f.base + '/missing', { headers: { 'Sec-Fetch-Dest': 'script' } })).status).toBe(404)
  })

  it('preserves HEAD navigation while rejecting unmatched writes', async () => {
    const f = await fixture()
    const head = await fetch(f.base + '/page', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect((await fetch(f.base + '/page', { method: 'POST' })).status).toBe(404)
  })
})
