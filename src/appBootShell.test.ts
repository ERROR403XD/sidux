import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

function extractInlineScript(id: string): string {
  const match = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html)
  if (!match) throw new Error(`missing inline script #${id}`)
  return match[1]
}

class StubElement {
  readonly id: string
  hidden = false
  textContent = ''
  removed = false
  onclick: (() => void) | null = null
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}

  constructor(id: string) {
    this.id = id
  }

  remove(): void {
    this.removed = true
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }
}

const BOOT_SHELL_IDS = [
  'app-boot',
  'app-boot-inner',
  'app-boot-spinner',
  'app-boot-label',
  'app-load-recovery',
  'app-load-title',
  'app-load-description',
  'app-load-reload',
  'app-load-dismiss',
]

const HIDDEN_BY_DEFAULT_IDS = ['app-load-recovery', 'app-load-dismiss']

function createElements(): Map<string, StubElement> {
  return new Map(
    BOOT_SHELL_IDS.map((id) => {
      const element = new StubElement(id)
      element.hidden = HIDDEN_BY_DEFAULT_IDS.includes(id)
      return [id, element]
    }),
  )
}

function createClassList(store: Set<string>) {
  return {
    toggle(name: string, force?: boolean): boolean {
      const next = force === undefined ? !store.has(name) : force
      if (next) store.add(name)
      else store.delete(name)
      return next
    },
  }
}

function runThemeBootstrap(options: { mode?: string | null; prefersDark?: boolean } = {}) {
  const htmlClasses = new Set<string>()
  const meta = new StubElement('app-theme-color')
  const sandbox = {
    document: {
      documentElement: { classList: createClassList(htmlClasses) },
      getElementById: (id: string) => (id === 'app-theme-color' ? meta : null),
    },
    localStorage: { getItem: () => options.mode ?? null },
    window: { matchMedia: () => ({ matches: options.prefersDark === true }) },
  }
  runInNewContext(extractInlineScript('app-theme-bootstrap'), sandbox)
  return { htmlClasses, meta }
}

function runLoadGuard(options: { language?: string } = {}) {
  const elements = createElements()
  const documentListeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const windowListeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const bodyClasses = new Set<string>()
  const sandbox = {
    localStorage: { getItem: (key: string) => (key === 'codex-web-local.ui-language.v1' ? options.language ?? null : null) },
    document: {
      addEventListener: (type: string, handler: (...args: unknown[]) => void) => {
        documentListeners[type] = [...(documentListeners[type] ?? []), handler]
      },
      getElementById: (id: string) => {
        const element = elements.get(id)
        return element && !element.removed ? element : null
      },
      body: { classList: createClassList(bodyClasses) },
    },
    window: {
      addEventListener: (type: string, handler: (...args: unknown[]) => void) => {
        windowListeners[type] = [...(windowListeners[type] ?? []), handler]
      },
    },
    location: { href: 'http://127.0.0.1:4173/' },
    history: { state: null, replaceState: vi.fn() },
    URL,
    setTimeout,
    clearTimeout,
  }
  runInNewContext(extractInlineScript('app-load-guard'), sandbox)
  const emit = (type: string, ...args: unknown[]) => {
    for (const handler of [...(documentListeners[type] ?? []), ...(windowListeners[type] ?? [])]) handler(...args)
  }
  return {
    boot: elements.get('app-boot') as StubElement,
    label: elements.get('app-boot-label') as StubElement,
    recoveryPanel: elements.get('app-load-recovery') as StubElement,
    bodyClasses,
    emit,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('startup boot shell markup', () => {
  it('loads the theme bootstrap before the application module', () => {
    expect(html.indexOf('id="app-theme-bootstrap"')).toBeGreaterThan(-1)
    expect(html.indexOf('id="app-theme-bootstrap"')).toBeLessThan(html.indexOf('src="/src/main.ts"'))
  })

  it('renders the boot overlay inside the mount container so mounting clears it', () => {
    expect(html).toMatch(/<div id="app">\s*<div id="app-boot"[\s\S]*?<\/div>\s*<\/div>/)
    expect(extractInlineScript('app-load-guard')).toContain("getElementById('app-boot')")
  })

  it('keeps the in-app theme switch in sync with the boot theme color meta', () => {
    const appSource = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
    expect(extractInlineScript('app-theme-bootstrap')).toContain("getElementById('app-theme-color')")
    expect(appSource).toContain("document.getElementById('app-theme-color')")
  })

  it('keeps the overlay opaque from the first frame and fades the label in later', () => {
    expect(html).toMatch(/#app-boot \{[^}]*background: #ffffff/)
    expect(html).toMatch(/html\.dark #app-boot \{[^}]*background: #09090b/)
    expect(html).toMatch(/app-boot-reveal 180ms ease-out 300ms forwards/)
  })
})

describe('startup theme bootstrap', () => {
  it('applies the stored dark theme before first paint', () => {
    const { htmlClasses, meta } = runThemeBootstrap({ mode: 'dark' })
    expect(htmlClasses.has('dark')).toBe(true)
    expect(meta.attributes.content).toBe('#09090b')
  })

  it('keeps the stored light theme without flicker', () => {
    const { htmlClasses, meta } = runThemeBootstrap({ mode: 'light', prefersDark: true })
    expect(htmlClasses.has('dark')).toBe(false)
    expect(meta.attributes.content).toBe('#ffffff')
  })

  it('follows the system preference when the stored theme is system', () => {
    expect(runThemeBootstrap({ mode: 'system', prefersDark: true }).htmlClasses.has('dark')).toBe(true)
    expect(runThemeBootstrap({ mode: null, prefersDark: false }).htmlClasses.has('dark')).toBe(false)
  })
})

describe('startup boot overlay lifecycle', () => {
  it('keeps the overlay visible until the app reports it mounted', () => {
    const guard = runLoadGuard()
    expect(guard.boot.removed).toBe(false)
    guard.emit('codexapp:mounted')
    expect(guard.boot.removed).toBe(true)
    expect(guard.recoveryPanel.hidden).toBe(true)
  })

  it('replaces a stalled overlay with the startup recovery panel', () => {
    vi.useFakeTimers()
    const guard = runLoadGuard()
    vi.advanceTimersByTime(15000)
    expect(guard.recoveryPanel.hidden).toBe(false)
    expect(guard.recoveryPanel.dataset.startup).toBe('true')
    expect(guard.bodyClasses.has('app-load-pending')).toBe(true)
    expect(guard.boot.removed).toBe(true)
  })

  it('keeps the dismiss button available when the app mounted but a chunk failed', () => {
    const guard = runLoadGuard()
    guard.emit('codexapp:mounted')
    const failure = new Error('Failed to fetch dynamically imported module')
    guard.emit('unhandledrejection', { reason: failure })
    expect(guard.recoveryPanel.hidden).toBe(false)
    expect(guard.recoveryPanel.dataset.startup).toBe('false')
    expect(guard.bodyClasses.has('app-load-pending')).toBe(false)
  })

  it('localizes the boot label with the recovery panel language', () => {
    const chinese = runLoadGuard({ language: 'zh-CN' })
    chinese.emit('DOMContentLoaded')
    expect(chinese.label.textContent).toBe('正在加载界面…')

    const english = runLoadGuard({ language: 'en' })
    english.emit('DOMContentLoaded')
    expect(english.label.textContent).toBe('Loading interface…')
  })
})
