import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { privateJson } from './apiProxy/store.js'
import { defaultWebUiBranding, webUiIconSizes, webUiIconUrl, type WebUiBranding } from '../webUiBranding.js'

type State = WebUiBranding & { icons: Record<string, string> }
export class WebUiBrandingStore {
  private state: State = { ...defaultWebUiBranding, icons: {} }
  private serial: Promise<unknown> = Promise.resolve()
  private ready: Promise<void>
  private defaultIcons = new Map<string, Buffer>()
  constructor(private home: string) {
    this.ready = (async () => {
      try { this.state = { ...this.state, ...JSON.parse(await readFile(join(home, 'webui-branding.json'), 'utf8')) } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })()
    void this.ready.catch(() => {})
  }
  async snapshot(): Promise<WebUiBranding> {
    await this.ready
    const { title, titleMode, logoVersion } = this.state
    return { title, titleMode, logoVersion }
  }
  save(input: { title?: unknown; titleMode?: unknown; icons?: unknown }): Promise<WebUiBranding> {
    const operation = this.serial.then(async () => {
      await this.ready
      const next = { ...this.state }
      if (input.title !== undefined) {
        if (typeof input.title !== 'string' || input.title.trim().length > 120) throw new Error('标题长度须为0至120个字符')
        next.title = input.title.trim()
      }
      if (input.titleMode !== undefined) {
        if (!['fixed', 'prefix'].includes(String(input.titleMode))) throw new Error('标题显示方式无效')
        next.titleMode = input.titleMode as 'fixed' | 'prefix'
      }
      if (input.icons === null) {
        next.icons = {}
        next.logoVersion = ''
      } else if (input.icons !== undefined) {
        if (!input.icons || typeof input.icons !== 'object') throw new Error('Logo格式无效')
        const icons: Record<string, string> = {}
        for (const name of [...webUiIconSizes.map(size => `icon-${size}`), 'maskable-512']) {
          const value = (input.icons as Record<string, unknown>)[name]
          if (typeof value !== 'string' || value.length > 1500000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Logo格式无效')
          const bytes = Buffer.from(value, 'base64')
          const size = Number(name.split('-')[1])
          if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) throw new Error('Logo尺寸无效')
          icons[name] = value
        }
        next.icons = icons
        next.logoVersion = createHash('sha256').update(JSON.stringify(icons)).digest('hex').slice(0, 16)
      }
      await mkdir(this.home, { recursive: true, mode: 0o700 })
      await privateJson(join(this.home, 'webui-branding.json'), next)
      this.state = next
      return this.snapshot()
    })
    this.serial = operation.catch(() => {})
    return operation
  }
  async decorateHtml(html: string): Promise<string> {
    const settings = await this.snapshot()
    const title = settings.title || 'Codex Web'
    const escaped = title.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
    return html.replace(/<title>[^<]*<\/title>/, () => `<title>${escaped}</title>`)
      .replace(/(<meta name="(?:apple-mobile-web-app-title|application-name)" content=")[^"]*("\s*\/?>)/g, (_match, before, after) => `${before}${escaped}${after}`)
      .replace(/href="\/webui-assets\/icon-(\d+)\.png"/g, (_match, size) => `href="${webUiIconUrl(Number(size), settings.logoVersion)}"`)
      .replace('</head>', () => `<script>window.__WEBUI_BRANDING__=${JSON.stringify(settings).replaceAll('<', '\\u003c')}</script></head>`)
  }
  async asset(req: IncomingMessage, res: ServerResponse, defaultIconDirectory?: string): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname
    if (!['GET', 'HEAD'].includes(req.method || '') || !(path.startsWith('/webui-assets/') || ['/manifest.webmanifest', '/favicon.ico', '/apple-touch-icon.png', '/browserconfig.xml'].includes(path))) return false
    await this.ready
    res.setHeader('Cache-Control', 'no-store')
    const end = (type: string, body: string | Buffer) => { res.setHeader('Content-Type', type); res.end(req.method === 'HEAD' ? undefined : body) }
    const settings = await this.snapshot()
    if (path === '/webui-assets/settings') end('application/json', JSON.stringify({ data: settings }))
    else if (path === '/manifest.webmanifest') {
      end('application/manifest+json', JSON.stringify({ id: '/', name: settings.title || 'Codex Web', short_name: settings.title || 'Codex Web', start_url: '/', scope: '/', display: 'standalone', background_color: '#020617', theme_color: '#020617', icons: [192, 512].map(size => ({ src: webUiIconUrl(size, settings.logoVersion), sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })).concat([{ src: webUiIconUrl(512, settings.logoVersion, true), sizes: '512x512', type: 'image/png', purpose: 'maskable' }]) }))
    } else if (path === '/browserconfig.xml') {
      end('application/xml', `<browserconfig><msapplication><tile><square150x150logo src="${webUiIconUrl(150, settings.logoVersion)}"/><TileColor>#020617</TileColor></tile></msapplication></browserconfig>`)
    } else {
      const name = path === '/favicon.ico' ? 'icon-64' : path === '/apple-touch-icon.png' ? 'icon-180' : /^\/webui-assets\/(icon-(?:32|64|150|180|192|512)|maskable-512)\.png$/.exec(path)?.[1]
      if (!name) { res.statusCode = 404; res.end(); return true }
      const encoded = this.state.icons[name]
      const defaultName = name === 'icon-180' ? 'apple-touch-icon.png' : name === 'maskable-512' ? 'maskable-512x512.png' : name === 'icon-512' ? 'pwa-512x512.png' : 'pwa-192x192.png'
      if (!encoded) {
        if (defaultIconDirectory) {
          const path = join(defaultIconDirectory, defaultName)
          let png = this.defaultIcons.get(path)
          if (!png) { png = await readFile(path); this.defaultIcons.set(path, png) }
          end('image/png', png)
          return true
        }
        res.statusCode = 302
        res.setHeader('Location', `/icons/${defaultName}`)
        res.end()
        return true
      }
      const png = Buffer.from(encoded, 'base64')
      if (path === '/favicon.ico') {
        const header = Buffer.alloc(22)
        header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
        header[6] = 64; header[7] = 64
        header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12)
        header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18)
        end('image/x-icon', Buffer.concat([header, png]))
      } else end('image/png', png)
    }
    return true
  }
}

const storeKey = '__codexappWebUiBrandingStoresV1'
export function getWebUiBrandingStore(): WebUiBrandingStore {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const global = globalThis as typeof globalThis & { [storeKey]?: Map<string, WebUiBrandingStore> }
  const stores = global[storeKey] ||= new Map()
  let store = stores.get(home)
  if (!store) { store = new WebUiBrandingStore(home); stores.set(home, store) }
  return store
}
