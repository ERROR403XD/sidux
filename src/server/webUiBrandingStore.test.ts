import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { WebUiBrandingStore } from './webUiBrandingStore'
import { webUiDocumentTitle, webUiIconSizes } from '../webUiBranding'

it('persists branding, escapes HTML, publishes sized icons/ICO/manifest and restores defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'webui-branding-'))
  const store = new WebUiBrandingStore(home)
  const server = createServer((req, res) => {
    void store.asset(req, res).then(handled => { if (!handled) res.writeHead(403).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture not listening')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const icons: Record<string, string> = {}
    for (const name of [...webUiIconSizes.map(size => `icon-${size}`), 'maskable-512']) {
      const header = Buffer.alloc(33)
      Buffer.from('89504e470d0a1a0a', 'hex').copy(header)
      header.writeUInt32BE(Number(name.split('-')[1]), 16)
      header.writeUInt32BE(Number(name.split('-')[1]), 20)
      icons[name] = header.toString('base64')
    }
    const saved = await store.save({ title: 'My <script> $& "UI"', titleMode: 'prefix', icons })
    expect(saved.logoVersion).toHaveLength(16)
    expect(saved).not.toHaveProperty('icons')
    const html = await store.decorateHtml('<head><meta name="apple-mobile-web-app-title" content="Codex Web"><title>Codex Web</title></head>')
    expect(html).toContain('My &lt;script&gt; $&amp; &quot;UI&quot;')
    expect(html).toContain('\\u003cscript>')
    expect(html).not.toContain('<script> $&')
    expect(await new WebUiBrandingStore(home).snapshot()).toEqual(saved)
    const manifest = await (await fetch(base + '/manifest.webmanifest')).json()
    expect(manifest.name).toBe(saved.title)
    expect(manifest.launch_handler).toEqual({ client_mode: 'focus-existing' })
    expect(manifest.icons.map((icon: { purpose: string }) => icon.purpose)).toEqual(['any', 'any', 'maskable'])
    for (const icon of manifest.icons) expect((await fetch(base + icon.src)).headers.get('content-type')).toBe('image/png')
    const ico = Buffer.from(await (await fetch(base + '/favicon.ico')).arrayBuffer())
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt32LE(18)).toBe(22)
    expect((await fetch(base + '/apple-touch-icon.png')).headers.get('content-type')).toBe('image/png')
    expect(await (await fetch(base + '/browserconfig.xml')).text()).toContain('square150x150logo')
    expect((await fetch(base + '/webui-assets/settings', { method: 'POST' })).status).toBe(403)
    await expect(store.save({ icons: { 'icon-32': '<svg/>' } })).rejects.toThrow()
    expect((await store.snapshot()).logoVersion).toBe(saved.logoVersion)
    await store.save({ icons: null })
    const restored = await fetch(base + '/webui-assets/icon-32.png', { redirect: 'manual' })
    expect(restored.status).toBe(302)
    expect(restored.headers.get('location')).toBe('/icons/pwa-192x192.png')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
it('supports fixed and prefixed conversation titles without changing the empty-title default', () => {
  const settings = { title: 'My UI', titleMode: 'prefix' as const, logoVersion: '' }
  expect(webUiDocumentTitle(settings, 'Conversation', 'localhost')).toBe('My UI - Conversation')
  expect(webUiDocumentTitle(settings, '', 'localhost')).toBe('My UI')
  expect(webUiDocumentTitle({ ...settings, titleMode: 'fixed' }, 'Conversation', 'localhost')).toBe('My UI')
  expect(webUiDocumentTitle({ ...settings, title: '' }, 'Conversation', 'localhost')).toBe('Conversation')
})
