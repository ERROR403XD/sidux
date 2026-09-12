// Deliberate security/compatibility experiment on disposable local files only.
// No application headers are changed. Browser routing adds the candidate CSP.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexapp-preview-isolation-'))
  const home = path.join(root, 'home')
  await fs.mkdir(home)
  const source = path.join(root, 'preview.html')
  const editable = path.join(root, 'editable.txt')
  await fs.writeFile(path.join(root, 'module.js'), 'export const value = "module-ok"')
  await fs.writeFile(path.join(root, 'data.json'), '{"value":"data-ok"}')
  await fs.writeFile(source, `<html><body><h1>Preview compatibility fixture</h1><pre id="result"></pre><script>
    (async()=>{const result={};for(const [key,fn] of Object.entries({module:()=>import('./module.js'),data:()=>fetch('./data.json').then(r=>r.json()),management:()=>fetch('/codex-api/thread-interruptions').then(r=>r.json())})){try{await fn();result[key]=true}catch{result[key]=false}}document.getElementById('result').textContent=JSON.stringify(result)})()
  </script></body></html>`)
  await fs.writeFile(path.join(root, 'preview.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="100"><text x="10" y="30" id="result">waiting</text><script>fetch('/codex-api/thread-interruptions').then(r=>r.json()).then(()=>document.getElementById('result').textContent='management-readable').catch(()=>document.getElementById('result').textContent='blocked')</script></svg>`)
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.resolve('dist-cli/index.js'), '--port', String(port), '--strict-port', '--no-password', '--no-open'], { cwd: root, env: { PATH: process.env.PATH, CODEX_HOME: home, CODEXUI_CODEX_COMMAND: path.resolve('src/server/fixtures/account-app-server.cjs'), LANG: 'C.UTF-8' }, stdio: 'ignore' })
  let browser
  const report = { base, viewport: '1000x700', cases: [], managementRequestsReadOnly: true }
  try {
    let ready = false
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(base + '/codex-api/thread-interruptions')).ok) { ready = true; break } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, 'isolated application ready')
    browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
    for (const [name, csp, expected] of [['baseline', '', true], ['opaque', 'sandbox allow-scripts', false], ['same-origin', 'sandbox allow-scripts allow-same-origin', true]]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
      page.on('pageerror', () => {}) // Opaque-origin editor failure is an expected finding.
      await page.route(base + '/**', async route => {
        const request = route.request()
        if (new URL(request.url()).pathname.startsWith('/codex-api/')) assert.equal(request.method(), 'GET')
        // Let the browser enforce CORS on real subresource traffic. Fulfilling
        // those requests from automation would invalidate this experiment.
        if (!request.isNavigationRequest()) return route.continue()
        const response = await route.fetch()
        await route.fulfill({ response, headers: { ...response.headers(), ...(request.isNavigationRequest() && csp ? { 'content-security-policy': csp } : {}) } })
      })
      // Keep the editor experiment offline; substitute only Ace's editor API.
      await page.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ contentType: 'application/javascript', body: `window.ace={edit:()=>{const t=document.createElement('textarea');t.id='fixtureEditor';document.getElementById('editor').append(t);return{setTheme(){},session:{setMode(){}},setValue(v){t.value=v},setOptions(){},resize(){},getValue(){return t.value}}}}` }))
      const url = base + '/codex-local-browse' + source
      await page.goto(url)
      await page.waitForFunction(() => document.getElementById('result')?.textContent.includes('management'))
      const preview = JSON.parse(await page.locator('#result').textContent())
      assert.deepEqual(preview, { module: expected, data: expected, management: expected })
      await page.waitForTimeout(2200)
      const screenshot = path.resolve(`output/playwright/0219-preview-isolation-${name}.png`)
      await page.screenshot({ path: screenshot })
      await fs.writeFile(editable, 'before')
      await page.goto(base + '/codex-local-edit' + editable)
      await page.locator('#fixtureEditor').fill('after')
      await page.locator('#saveBtn').click()
      await page.waitForTimeout(500)
      const editSaved = (await fs.readFile(editable, 'utf8')) === 'after'
      assert.equal(editSaved, expected)
      await page.goto(base + '/codex-local-image?' + new URLSearchParams({ path: path.join(root, 'preview.svg') }))
      await page.waitForFunction(() => document.getElementById('result')?.textContent !== 'waiting')
      const svgManagementReadable = await page.locator('#result').textContent() === 'management-readable'
      assert.equal(svgManagementReadable, expected)
      report.cases.push({ name, csp, url, preview, editSaved, svgManagementReadable, screenshot })
      await page.close()
    }
    report.passed = true
    await fs.writeFile('output/0219-final/preview-isolation.json', JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000).unref() })
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)) }
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
