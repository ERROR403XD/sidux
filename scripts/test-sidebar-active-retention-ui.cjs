const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')

async function main() {
  const base = process.env.UI_BASE_URL || 'http://127.0.0.1:4173'
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const label = process.env.UI_LABEL ? process.env.UI_LABEL + '-' : ''
  const report = { base, cases: [], requests: [], errors: [], screenshots: [] }
  const ids = Object.fromEntries(['anchor', 'blue', 'network', 'quota', 'manual', 'old'].map((name, i) => [name, `${i + 1}1111111-1111-4111-8111-111111111111`]))
  const turns = Object.fromEntries(Object.keys(ids).map(name => [name, { id: `turn-${name}`, status: name === 'old' ? 'completed' : 'inProgress', items: [{ id: `user-${name}`, type: 'userMessage', content: [{ type: 'text', text: `Local ${name} fixture` }] }] }]))
  const completions = { [ids.old]: 'turn-old' }
  const issues = {}
  const ignored = {}
  const visibleIssues = () => Object.fromEntries(Object.entries(issues).map(([id, rows]) => [id, rows.filter(row => !(ignored[id] || []).includes(row.turnId))]).filter(([, rows]) => rows.length))
  const native = id => {
    const name = Object.keys(ids).find(name => ids[name] === id) || 'anchor'
    return { id, name: `Fixture ${name}`, cwd: '/tmp/sidebar-fixture', createdAt: 1789220000, updatedAt: 1789220000, status: { type: turns[name].status === 'inProgress' ? 'active' : 'idle' }, source: 'cli', modelProvider: 'openai', turns: [turns[name]] }
  }
  let page
  let notify = async () => {}
  let failIgnore = false
  let holdReads = false
  const heldReads = []
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      localStorage.setItem('codex-web-local.ui-language.v1', 'en')
      window.WebSocket = undefined
      window.__streams = []
      window.EventSource = class extends EventTarget {
        static CLOSED = 2
        readyState = 1
        constructor() { super(); window.__streams.push(this); setTimeout(() => this.dispatchEvent(new MessageEvent('ready', { data: '{}' })), 50) }
        close() { this.readyState = 2 }
      }
      window.__notify = payload => window.__streams.forEach(stream => stream.onmessage?.({ data: JSON.stringify(payload) }))
    })
    await context.route('**/codex-api/**', async route => {
      const req = route.request()
      const path = new URL(req.url()).pathname.slice('/codex-api/'.length)
      const body = req.postData() ? req.postDataJSON() : {}
      report.requests.push({ path, method: req.method(), rpc: body.method, operation: body.type })
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
      if (path === 'rpc') {
        if (body.method === 'thread/list') return json({ result: { data: Object.values(ids).map(native), nextCursor: null } })
        if (['thread/read', 'thread/resume'].includes(body.method)) return json({ result: { thread: native(body.params.threadId), model: 'fixture' } })
        if (body.method === 'config/read') return json({ result: { config: { model: 'fixture', model_provider: 'openai' } } })
        if (body.method === 'model/list') return json({ result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }] } })
        return json({ result: { data: [], nextCursor: null } })
      }
      if (path === 'workspace-roots-state') return json({ data: { order: ['/tmp/sidebar-fixture'], labels: {}, active: ['/tmp/sidebar-fixture'], projectOrder: ['/tmp/sidebar-fixture'], virtualProjects: [] } })
      if (['provider-models', 'accounts/models'].includes(path)) return json({ data: [{ id: 'fixture', model: 'fixture', isDefault: true }] })
      if (path === 'thread-completions') {
        if (req.method() === 'POST' && completions[body.threadId] === body.token) delete completions[body.threadId]
        return json({ data: completions })
      }
      if (path === 'thread-interruptions') {
        if (holdReads) { heldReads.push(route); return }
        return json({ data: visibleIssues() })
      }
      if (path === 'ignored-quota-errors') {
        const id = body.threadId || new URL(req.url()).searchParams.get('threadId')
        if (req.method() === 'POST') {
          if (failIgnore) return json({ error: 'fixture save failed' }, 503)
          const next = new Set(ignored[id] || [])
          body.ignored ? next.add(body.turnId) : next.delete(body.turnId)
          ignored[id] = [...next]
          await notify({ method: 'codexapp/interruptions/changed', params: { threadId: id, issues: visibleIssues()[id] || [] } })
          await notify({ method: 'thread/quotaErrorIgnored/changed', params: { threadId: id } })
        }
        return json({ data: ignored[id] || [] })
      }
      if (path === 'sidebar-thread-status') return json({ data: Object.fromEntries(body.threadIds.map(id => [id, Boolean(visibleIssues()[id]?.length)])) })
      if (path === 'thread-queue-state') return json({ data: {} })
      if (path === 'thread-titles') return json({ data: { titles: {} } })
      if (path === 'thread-goals') return json({ data: Object.fromEntries((body.threadIds || []).map(id => [id, null])) })
      if (path === 'thread-pins') return json({ data: { threadIds: [] } })
      if (['thread-automations', 'project-automations'].includes(path)) return json({ data: {} })
      if (req.method() !== 'GET') return json({ ok: true, data: {} })
      return route.continue()
    })
    page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    notify = async payload => {
      await page.waitForFunction(() => window.__streams.length >= 2 && window.__streams.every(stream => typeof stream.onmessage === 'function'))
      await page.evaluate(value => window.__notify(value), payload)
    }
    const button = name => page.locator('.thread-main-button').filter({ hasText: `Fixture ${name}` }).first()
    const row = name => page.locator('.thread-row').filter({ has: button(name) }).first()
    const shown = async (name, expected = true) => { await (expected ? button(name).waitFor() : button(name).waitFor({ state: 'hidden' })) }
    const dot = async (name, kind) => {
      await row(name).locator(`.thread-status-indicator[data-state="${kind}"]`).waitFor()
      return row(name).locator('.thread-status-indicator').evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, color: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderRadius }))
    }
    const finish = async (name, status, error) => {
      turns[name] = { ...turns[name], status, error }
      completions[ids[name]] = turns[name].id
      if (status === 'failed') {
        issues[ids[name]] = [{ turnId: turns[name].id, kind: name === 'quota' ? 'quota' : 'error' }]
        await notify({ method: 'codexapp/interruptions/changed', params: { threadId: ids[name], issues: issues[ids[name]] } })
      }
      await notify({ method: 'turn/completed', params: { threadId: ids[name], turn: turns[name] } })
      await notify({ method: 'codexapp/completions/changed', params: { threadId: ids[name], token: turns[name].id } })
    }
    await page.goto(`${base}/#/thread/${ids.anchor}`)
    await shown('old')
    await dot('old', 'unread')
    await page.getByRole('button', { name: 'Active', exact: true }).click()
    await shown('old', false)
    await finish('blue', 'completed', null)
    await finish('network', 'failed', { message: 'connection reset by local fixture' })
    await finish('quota', 'failed', { message: 'quota exceeded in local fixture', codexErrorInfo: 'usageLimitExceeded' })
    await dot('blue', 'unread')
    const red = await dot('network', 'error')
    const yellow = await dot('quota', 'quota')
    assert.equal(red.color, 'rgb(239, 68, 68)')
    assert.equal(yellow.color, 'rgb(234, 179, 8)')
    assert.equal(red.width, yellow.width)
    assert(Math.abs(red.width - 6.6667) < 0.1)
    report.cases.push('initial unread excluded; completions and both errors retained with equal-size blue/red/yellow dots')
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await page.mouse.move(1400, 900)
      await page.waitForTimeout(2200)
      const path = `output/playwright/0219-${label}sidebar-active-${dark ? 'dark' : 'light'}.png`
      await page.screenshot({ path })
      report.screenshots.push({ path, viewport: { width: 1440, height: 1000 }, dark })
    }
    for (const viewport of [{ width: 768, height: 1024 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(200)
      if (await page.getByRole('button', { name: 'Expand sidebar', exact: true }).isVisible()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      await dot('network', 'error')
      await dot('quota', 'quota')
      await row('network').hover()
      await row('network').locator('.thread-menu-trigger').click()
      const menu = await page.locator('.thread-menu-panel').boundingBox()
      assert(menu && menu.x >= 0 && menu.x + menu.width <= viewport.width)
      await page.keyboard.press('Escape')
      for (const dark of [false, true]) {
        await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
        await page.mouse.move(viewport.width - 5, viewport.height - 5)
        await page.waitForTimeout(2200)
        const path = `output/playwright/0219-${label}sidebar-active-${viewport.width}-${dark ? 'dark' : 'light'}.png`
        await page.screenshot({ path })
        report.screenshots.push({ path, viewport, dark })
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.waitForTimeout(200)
    if (await page.getByRole('button', { name: 'Expand sidebar', exact: true }).isVisible()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    report.cases.push('tablet/mobile sidebar remount keeps active retention and dots; problem menu stays inside viewport in both themes')
    await button('manual').click()
    await finish('manual', 'interrupted', null)
    await shown('manual')
    assert.equal(await row('manual').locator('[data-state="error"], [data-state="quota"]').count(), 0)
    await button('anchor').click()
    await shown('manual', false)
    await button('blue').click()
    await shown('blue')
    await button('anchor').click()
    await shown('blue', false)
    report.cases.push('selected manual stop and normal completion stay until switching conversations')
    await button('network').click()
    await dot('network', 'error')
    await page.locator('.quota-error-ignore').waitFor()
    await button('anchor').click()
    await shown('network', false)
    await page.getByRole('button', { name: 'Active', exact: true }).click()
    await dot('network', 'error')
    await page.getByRole('button', { name: 'Active', exact: true }).click()
    await shown('quota', false)
    await shown('network', false)
    await shown('anchor')
    report.cases.push('read does not clear error; active off/on discards all finished rows despite persistent problems')
    await page.reload()
    await dot('network', 'error')
    await dot('quota', 'quota')
    await page.getByRole('button', { name: 'Interrupted', exact: true }).click()
    await shown('network')
    await shown('quota')
    await shown('manual', false)
    await shown('anchor', false)
    await button('network').click()
    await page.locator('.quota-error-ignore').getByText('Ignore', { exact: true }).click()
    await row('network').locator('[data-state="error"]').waitFor({ state: 'hidden' })
    await shown('network')
    await page.locator('.quota-error-ignore').getByText('Ignored', { exact: true }).click()
    await dot('network', 'error')
    await button('quota').click()
    await shown('network')
    await row('network').dispatchEvent('contextmenu', { button: 2, clientX: 200, clientY: 400 })
    failIgnore = true
    await page.getByRole('button', { name: 'Ignore all problems', exact: true }).click()
    await page.locator('.thread-menu-panel [role="alert"]').waitFor()
    await dot('network', 'error')
    failIgnore = false
    await page.getByRole('button', { name: 'Ignore all problems', exact: true }).click()
    await shown('network', false)
    await page.mouse.click(1300, 900)
    await page.reload()
    await shown('network')
    assert.equal(await row('network').locator('[data-state="error"]').count(), 0)
    await dot('quota', 'quota')
    report.cases.push('both errors survive reload and match Interrupted; per-turn ignore/undo and thread menu ignore survive reload; failed save preserves red dot')
    holdReads = true
    await notify({ method: 'ready', params: {} })
    await page.waitForTimeout(150)
    assert.ok(heldReads.length >= 1)
    await row('quota').dispatchEvent('contextmenu', { button: 2, clientX: 200, clientY: 350 })
    await page.getByRole('button', { name: 'Ignore all problems', exact: true }).click()
    await row('quota').locator('[data-state="quota"]').waitFor({ state: 'hidden' })
    await page.mouse.click(1300, 900)
    issues[ids.network] = [{ turnId: 'turn-network-new', kind: 'error' }]
    await notify({ method: 'codexapp/interruptions/changed', params: { threadId: ids.network, issues: issues[ids.network] } })
    await dot('network', 'error')
    await row('network').dispatchEvent('contextmenu', { button: 2, clientX: 200, clientY: 400 })
    assert.equal(await page.getByRole('button', { name: 'Ignore all problems', exact: true }).isEnabled(), true)
    await page.getByRole('button', { name: 'Ignore all problems', exact: true }).click()
    await row('network').locator('[data-state="error"]').waitFor({ state: 'hidden' })
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await page.waitForTimeout(2200)
      const path = `output/playwright/0219-${label}ignore-stalled-snapshot-${dark ? 'dark' : 'light'}.png`
      await page.screenshot({ path })
      report.screenshots.push({ path, viewport: { width: 1440, height: 1000 }, dark })
    }
    holdReads = false
    for (const route of heldReads) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: visibleIssues() }) }).catch(() => {})
    }
    report.cases.push('stalled snapshots do not block two consecutive problem ignores; acknowledged dots clear while reads wait')
    report.performance = await page.evaluate(async () => {
      const { ActiveSidebarSession } = await import('/src/activeSidebarSession.ts')
      const rows = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), inProgress: i % 10 === 0, unread: false }))
      const state = new ActiveSidebarSession()
      state.reset(true, rows, '')
      const times = []
      for (let i = 0; i < 100; i++) { const start = performance.now(); state.update(rows, String(i)); times.push(performance.now() - start) }
      times.sort((a, b) => a - b)
      return { rows: rows.length, samples: times.length, medianMs: times[50], p95Ms: times[95] }
    })
    assert.equal(report.requests.filter(row => ['turn/start', 'turn/interrupt', 'account/login/start'].includes(row.rpc)).length, 0)
    assert.deepEqual(report.errors, [])
    await fs.writeFile(process.env.UI_REPORT_PATH || 'output/0219-final/sidebar-ui.json', JSON.stringify(report, null, 2))
    console.log('SIDEBAR_ACTIVE_UI_PASS', JSON.stringify({ cases: report.cases, screenshots: report.screenshots, performance: report.performance }))
  } catch (error) {
    if (page) await page.screenshot({ path: 'output/playwright/0219-sidebar-active-failure.png' }).catch(() => {})
    await fs.writeFile('output/0219-final/sidebar-ui-failure.json', JSON.stringify({ ...report, error: error.stack }, null, 2))
    throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
