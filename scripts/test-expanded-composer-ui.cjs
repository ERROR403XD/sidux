const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
async function main() {
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const report = { url: 'http://127.0.0.1:4173', cases: [], screenshots: [], pageErrors: [], executionRequests: 0 }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => report.pageErrors.push(error.message))
    page.on('request', request => { if (request.url().endsWith('/codex-api/rpc') && request.method() === 'POST' && /turn\/(start|interrupt)|account\/login/.test(request.postData() || '')) report.executionRequests++ })
    await page.addInitScript(() => localStorage.setItem('codex-web-local.ui-language.v1', 'zh-CN'))
    await page.goto(report.url)
    const input = page.locator('.thread-composer-input')
    const picker = page.locator('.composer-command-picker')
    const expand = page.locator('.thread-composer-expand')
    await input.waitFor()
    for (const original of ['正文', 'existing', '后文 test', '/plan 后文', '/plan\n后文', ' ', '\n']) {
      await input.fill(original)
      await input.press('ControlOrMeta+Home')
      if (!original.startsWith('/')) await input.pressSequentially('/')
      await input.click()
      assert.equal(await picker.count(), 0, 'existing draft must not open the command picker: ' + original)
    }
    await input.fill('/plan') // Filling/pasting/restoring is not a fresh slash key.
    assert.equal(await picker.count(), 0)
    await input.fill('')
    await input.pressSequentially('/pl')
    await picker.waitFor()
    await input.press('ArrowDown')
    await input.press('Enter')
    assert.equal(await input.inputValue(), '')
    assert.equal(await picker.count(), 0)
    report.cases.push('empty-only opening, nonempty suffix/prefix, paste/fill suppression and keyboard command selection')
    await expand.click()
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await input.fill('')
      await input.pressSequentially('/')
      await picker.waitFor()
      for (const [width, height] of [[1440, 1000], [1440, 620], [1100, 620], [768, 1024], [375, 812], [375, 500], [1440, 1000]]) {
        await page.setViewportSize({ width, height })
        await page.waitForTimeout(250)
        const rects = await page.evaluate(() => Object.fromEntries(['.content-root', '.content-header', '.thread-composer', '.thread-composer-input', '.thread-composer-controls', '.composer-command-picker'].map(selector => {
          const r = document.querySelector(selector).getBoundingClientRect()
          return [selector, { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right }]
        })))
        const content = rects['.content-root'], composer = rects['.thread-composer'], header = rects['.content-header'], field = rects['.thread-composer-input'], panel = rects['.composer-command-picker']
        assert.ok(Math.abs(composer.bottom - content.bottom) < 2, JSON.stringify({ width, height, composer, content }))
        assert.ok(Math.abs(composer.x - content.x) < 2)
        assert.ok(composer.y >= header.bottom && composer.y <= header.bottom + 10)
        assert.ok(rects['.thread-composer-controls'].bottom <= composer.bottom)
        assert.ok(panel.x >= 0 && panel.y >= 0 && panel.right <= width + 1 && panel.bottom <= height + 1)
        assert.ok(Math.abs(panel.x + panel.width / 2 - field.x - field.width / 2) < 2)
        assert.ok(panel.y >= field.y + 30)
        assert.equal(await input.inputValue(), '/')
        report.cases.push({ width, height, dark, rects })
        if ((width === 375 && height === 812) || width === 768 || (width === 1440 && height === 620)) {
          await page.waitForTimeout(2200)
          const screenshot = path.resolve(`output/playwright/0219-sealed-composer-${width}-${dark ? 'dark' : 'light'}.png`)
          await page.screenshot({ path: screenshot })
          report.screenshots.push({ width, height, dark, screenshot })
        }
      }
      await input.press('Escape')
      await input.pressSequentially('plan')
      assert.equal(await picker.count(), 0)
    }
    const text = '保持草稿与选择位置\nresize fixture'
    await input.fill(text)
    await input.evaluate(element => element.setSelectionRange(2, 6))
    await page.setViewportSize({ width: 1100, height: 620 })
    await page.waitForTimeout(100)
    assert.deepEqual(await input.evaluate(element => [element.value, element.selectionStart, element.selectionEnd]), [text, 2, 6])
    await expand.click()
    assert.deepEqual(await input.evaluate(element => [element.value, element.selectionStart, element.selectionEnd]), [text, 2, 6])
    await input.fill('')
    assert.equal(report.executionRequests, 0)
    assert.deepEqual(report.pageErrors, [])
    report.passed = true
  } finally {
    await browser.close()
    await fs.writeFile('output/0219-final/sealed-composer-ui.json', JSON.stringify(report, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
