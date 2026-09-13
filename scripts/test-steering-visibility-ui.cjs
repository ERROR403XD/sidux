const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')

async function main() {
  const base = process.env.UI_BASE_URL || 'http://127.0.0.1:4173'
  const screenshotLabel = process.env.UI_SCREENSHOT_LABEL || ''
  assert.match(screenshotLabel, /^[a-z0-9-]*$/)
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const report = { base, cases: [], requests: [], errors: [], screenshots: [] }
  const liveId = '11111111-1111-4111-8111-111111111111'
  const otherId = '22222222-2222-4222-8222-222222222222'
  const native = id => ({ id, name: id === liveId ? 'Steering test' : 'Other conversation', cwd: '/tmp/steering-ui', createdAt: 1789220000, updatedAt: 1789220000, status: { type: id === liveId ? 'active' : 'idle' }, source: 'cli', modelProvider: 'openai', turns: id === liveId ? [{ id: 'turn-1', status: 'inProgress', items: [{ id: 'original-user', type: 'userMessage', content: [{ type: 'text', text: 'Original task' }] }, ...items] }] : [] })
  const items = []
  const id = `d-${Date.now()}-steer-ui`
  const marker = 'TestChat-steer-0219 **visible** [guide](/tmp/steering-guide.md)'
  const message = { id, text: marker, imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default', model: 'fixture', delivery: { mode: 'queue', status: 'queued', revision: 1, createdAt: Date.now(), updatedAt: Date.now() } }
  let queue = { [liveId]: [message] }
  let receipts = []
  let releaseSteer
  let holdSteer = true
  let queueReadsFail = false
  let historyReadsFail = false
  let page
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(({ failDisplayStorage }) => {
      localStorage.setItem('codex-web-local.ui-language.v1', 'en')
      if (failDisplayStorage) {
        const original = Storage.prototype.setItem
        Storage.prototype.setItem = function (key, value) {
          if (this === localStorage && key.startsWith('codexapp.delivery-view.v1.')) throw new DOMException('Fixture display storage full', 'QuotaExceededError')
          return original.call(this, key, value)
        }
      }
      window.WebSocket = undefined
      window.__streams = []
      window.EventSource = class extends EventTarget {
        static CLOSED = 2
        readyState = 1
        constructor() { super(); window.__streams.push(this); setTimeout(() => this.dispatchEvent(new MessageEvent('ready', { data: '{}' })), 50) }
        close() { this.readyState = 2 }
      }
      window.__notify = payload => window.__streams.forEach(stream => stream.onmessage?.({ data: JSON.stringify(payload) }))
    }, { failDisplayStorage: process.env.UI_FAIL_DISPLAY_STORAGE === '1' })
    await context.route('**/codex-api/**', async route => {
      const req = route.request()
      const url = new URL(req.url())
      const path = url.pathname.slice('/codex-api/'.length)
      const body = req.postData() ? req.postDataJSON() : {}
      report.requests.push({ path, method: req.method(), rpc: body.method, operation: body.type })
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
      if (path === 'rpc') {
        if (body.method === 'thread/list') return json({ result: { data: [native(liveId), native(otherId)], nextCursor: null } })
        if (['thread/read', 'thread/resume'].includes(body.method)) {
          if (historyReadsFail) return json({ error: { message: 'fixture history unavailable' } }, 503)
          return json({ result: { thread: native(body.params.threadId), model: 'fixture' } })
        }
        if (body.method === 'config/read') return json({ result: { config: { model: 'fixture', model_provider: 'openai' } } })
        if (body.method === 'model/list') return json({ result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }] } })
        return json({ result: { data: [], nextCursor: null } })
      }
      if (path === 'workspace-roots-state') return json({ data: { order: ['/tmp/steering-ui'], labels: {}, active: ['/tmp/steering-ui'], projectOrder: ['/tmp/steering-ui'], virtualProjects: [] } })
      if (path === 'provider-models' || path === 'accounts/models') return json({ data: [{ id: 'fixture', model: 'fixture', isDefault: true }] })
      if (path === 'thread-queue-state') {
        if (req.method() === 'POST') {
          if (body.type === 'steer') {
            if (holdSteer) await new Promise(resolve => { releaseSteer = resolve })
            message.delivery = { ...message.delivery, mode: 'steer', status: 'queued', revision: 2 }
          } else if (body.type === 'remove') {
            queue = {}
            receipts = [{ id, status: 'cancelled' }]
            return json({ data: { state: queue, removed: message } })
          } else throw new Error(`Unexpected mutation ${body.type}`)
          return json({ data: { state: queue } })
        }
        return queueReadsFail ? json({ error: 'fixture queue unavailable' }, 503) : json({ data: queue })
      }
      if (path === 'delivery-status') return json({ data: receipts })
      if (path === 'thread-titles') return json({ data: { titles: {} } })
      if (path === 'thread-goals') return json({ data: Object.fromEntries((body.threadIds || []).map(id => [id, null])) })
      if (path === 'thread-pins') return json({ data: { threadIds: [] } })
      if (['thread-automations', 'project-automations'].includes(path)) return json({ data: {} })
      if (req.method() !== 'GET') return json({ ok: true, data: {} })
      return route.continue()
    })
    page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    page.on('console', entry => {
      if (entry.type() === 'error') console.error('Browser console:', entry.text())
    })
    page.on('requestfailed', request => console.error('Browser request failed:', new URL(request.url()).pathname, request.failure()?.errorText))
    const row = () => page.locator('.conversation-item[data-role="user"]').filter({ hasText: 'TestChat-steer-0219' })
    const notify = async params => {
      await page.waitForFunction(() => window.__streams.length >= 2 && window.__streams.every(stream => typeof stream.onmessage === 'function'))
      await page.evaluate(value => window.__notify(value), params)
    }
    const changed = () => notify({ method: 'codexapp/queue/changed', params: { threadId: liveId } })
    await page.goto(`${base}/#/thread/${liveId}`)
    const queueRow = page.locator(`.queued-row[data-delivery-id="${id}"]`)
    await queueRow.waitFor()
    assert.equal(await row().count(), 0)
    await queueRow.getByRole('button', { name: 'Steer', exact: true }).click()
    await row().waitFor()
    await row().locator('[data-status="submitting"]').waitFor()
    await page.locator('.thread-main-button').filter({ hasText: 'Other conversation' }).first().click()
    assert.equal(await row().count(), 0)
    await page.locator('.thread-main-button').filter({ hasText: 'Steering test' }).first().click()
    await row().waitFor()
    assert.equal(await row().count(), 1)
    // Reload while the mutation is still pending: the display intent remains uncertain.
    await page.reload()
    await row().waitFor()
    await row().locator('[data-status="unknown"]').waitFor()
    releaseSteer()
    holdSteer = false
    await changed()
    await row().locator('[data-status="queued"]').waitFor()
    report.cases.push('queue-to-steer appears before HTTP completion; switch away/back and reload while request is pending')
    for (const status of ['sending', 'unknown', 'failed']) {
      message.delivery = { ...message.delivery, status, revision: message.delivery.revision + 1, ...(status === 'failed' ? { error: 'Fixture before-send failure' } : {}) }
      await changed()
      await row().locator(`[data-status="${status}"]`).waitFor()
      await page.reload()
      await row().locator(`[data-status="${status}"]`).waitFor()
      assert.equal(await row().count(), 1)
    }
    report.cases.push('sending, unknown and failed states survive reload with one visible message')
    queueReadsFail = true
    historyReadsFail = true
    await page.reload()
    await row().waitFor()
    assert.equal(await row().count(), 1)
    queueReadsFail = false
    historyReadsFail = false
    await page.reload()
    await row().waitFor()
    report.cases.push('history and queue read failures preserve visible content from display cache')
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport)
      for (const dark of [false, true]) {
        await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
        await page.waitForTimeout(2200)
        const screenshot = `output/playwright/0219-steering-${screenshotLabel ? screenshotLabel + '-' : ''}${viewport.width}-${dark ? 'dark' : 'light'}.png`
        await page.screenshot({ path: screenshot, fullPage: true })
        report.screenshots.push(screenshot)
        assert.equal(await row().count(), 1)
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    const guide = row().locator('a').filter({ hasText: 'guide' })
    const href = await guide.getAttribute('href')
    report.testChat = { hrefOk: new URL(href, base).pathname === '/codex-local-browse/tmp/steering-guide.md', titleOk: (await guide.getAttribute('title')) === '/tmp/steering-guide.md', textOk: (await guide.innerText()) === 'guide' }
    assert.ok(Object.values(report.testChat).every(Boolean))
    const testChatScreenshot = `output/playwright/testchat-steering-visibility${screenshotLabel ? '-' + screenshotLabel : ''}-cjs.png`
    await page.screenshot({ path: testChatScreenshot, fullPage: true })
    report.screenshots.push(testChatScreenshot)
    // Disappearance from queue is not disappearance from conversation; an immutable
    // receipt bridges late native history and never causes a new submission.
    queue = {}
    receipts = [{ id, status: 'accepted', turnId: 'turn-1' }]
    await changed()
    await row().locator('[data-status="accepted"]').waitFor()
    await page.reload()
    await row().locator('[data-status="accepted"]').waitFor()
    if (process.env.UI_FAIL_DISPLAY_STORAGE === '1') {
      const storageEvidence = await page.evaluate(() => ({
        persistent: Object.keys(localStorage).filter(key => key.startsWith('codexapp.delivery-view.v1.')).length,
        tab: Object.keys(sessionStorage).filter(key => key.startsWith('codexapp.delivery-view.v1.')).length,
      }))
      assert.equal(storageEvidence.persistent, 0)
      assert.equal(storageEvidence.tab, 1)
      report.storageFallback = storageEvidence
      report.cases.push('full persistent display storage uses tab storage; accepted content remains visible after refresh')
    }
    const item = { id: 'native-steer', type: 'userMessage', clientUserMessageId: id, content: [{ type: 'text', text: marker }] }
    items.push(item)
    await notify({ method: 'item/completed', params: { threadId: liveId, turnId: 'turn-1', item } })
    await row().locator('.conversation-delivery-status').waitFor({ state: 'hidden' })
    assert.equal(await row().count(), 1)
    assert.equal(await row().locator('.conversation-delivery-status').count(), 0)
    await page.reload()
    await row().waitFor()
    assert.equal(await row().count(), 1)
    if (process.env.UI_FAIL_DISPLAY_STORAGE === '1') {
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('codexapp.delivery-view.v1.')).length), 0)
    }
    report.cases.push('accepted receipt survives missing history, then one native echo replaces presentation through refresh')
    assert.equal(report.requests.filter(request => request.path === 'thread-queue-state' && request.operation === 'steer').length, 1)
    assert.ok(!report.requests.some(request => ['delivery', 'accounts/switch'].includes(request.path) || ['turn/start', 'turn/interrupt'].includes(request.rpc)))
    assert.deepEqual(report.errors, [])
    if (process.env.UI_SOURCE_PERF === '0') {
      // Installed bundles have no /src module endpoint. All UI assertions above
      // still run; the source-only microbenchmark is measured on Vite separately.
      report.presentationPerformance = { measured: false, reason: 'Source microbenchmark runs separately on the development server' }
    } else {
      report.presentationPerformance = await page.evaluate(async () => {
        const { useConversationDeliveries } = await import('/src/composables/useConversationDeliveries.ts')
        const tracker = useConversationDeliveries()
        const native = Array.from({ length: 5000 }, (_, index) => ({ id: `p-${index}`, role: index % 2 ? 'assistant' : 'user', text: 'history', turnId: `t-${index}` }))
        for (let index = 0; index < 100; index++) tracker.begin('performance-only', { id: `bench-${index}`, text: 'pending', imageUrls: [], skills: [], fileAttachments: [], collaborationMode: 'default' })
        for (let index = 0; index < 10; index++) tracker.project('performance-only', native)
        const samples = []
        for (let index = 0; index < 100; index++) {
          const started = performance.now()
          const result = tracker.project('performance-only', native)
          if (result.length !== 5100) throw new Error('Invalid performance fixture')
          samples.push(performance.now() - started)
        }
        samples.sort((a, b) => a - b)
        return { historyMessages: 5000, visibleDeliveries: 100, samples: 100, medianMs: samples[50], p95Ms: samples[95], noDeliveriesReusesHistory: tracker.project('no-deliveries', native) === native }
      })
    }
    report.passed = true
  } catch (error) {
    if (page) await page.screenshot({ path: 'output/playwright/0219-steering-failure.png', fullPage: true }).catch(() => {})
    throw error
  } finally {
    releaseSteer?.()
    await fs.mkdir('output/0219-final', { recursive: true })
    await fs.writeFile(process.env.UI_REPORT_PATH || 'output/0219-final/steering-ui.json', JSON.stringify(report, null, 2))
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
