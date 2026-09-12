// Actual packed application and native Codex CLI. Credentials are synthetic.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { chromium } = require('playwright')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexapp-package-matrix-'))
  const containers = []
  const report = { image: 'codexapp-final-test:0.2.19', native: '0.153.4', cases: [], actualCloudSuccessTested: false }
  let browser
  try {
    for (const [index, name] of ['noauth', 'malformed', 'invalid'].entries()) {
      const home = path.join(root, name)
      await fs.mkdir(home)
      if (name === 'malformed') await fs.writeFile(path.join(home, 'auth.json'), '{ malformed fixture')
      if (name === 'invalid') await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'fixture-invalid', access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-invalid', user_id: 'fixture-invalid' } })).toString('base64url') + '.invalid-signature', refresh_token: 'fixture-invalid-no-real-token' } }))
      const port = 4195 + index
      const container = `codexapp-0219-matrix-${name}`
      docker('run', '-d', '--name', container, '-p', `127.0.0.1:${port}:4190`, '-v', `${home}:/codex-home`, '-v', '/etc/ssl/certs/ca-certificates.crt:/fixture-ca.pem:ro', '-e', 'CODEX_CA_CERTIFICATE=/fixture-ca.pem', '-e', 'SSL_CERT_FILE=/fixture-ca.pem', '-e', 'NODE_EXTRA_CA_CERTS=/fixture-ca.pem', report.image)
      containers.push(container)
      const base = `http://127.0.0.1:${port}`
      let ready = false
      for (let i = 0; i < 180; i++) { try { if ((await fetch(base)).ok) { ready = true; break } } catch {}; await delay(100) }
      assert.ok(ready, `${name} app startup`)
      const post = async (route, body) => { const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) }); const j = await r.json(); assert.ok(r.ok, `${route} ${r.status} ${j.error || ''}`); return j }
      const rpc = async (method, params = {}) => (await post('/codex-api/rpc', { method, params })).result
      const provider = (await rpc('config/read')).config.model_provider || 'openai'
      assert.equal(provider, name === 'invalid' ? 'openai' : 'opencode_zen')
      const row = { name, base, provider }
      if (name === 'noauth') {
        await post('/codex-api/free-mode/custom-provider', { provider: 'openrouter', apiKey: 'fixture-not-a-real-key', wireApi: 'responses' })
        row.switchedProvider = (await rpc('config/read')).config.model_provider
        assert.equal(row.switchedProvider, 'openrouter_free')
      }
      if (name === 'invalid') {
        const before = await fs.readFile(path.join(home, 'auth.json'), 'utf8')
        const id = (await rpc('thread/start', { cwd: '/tmp', model: 'gpt-5.6', approvalPolicy: 'never', sandbox: 'read-only' })).thread.id
        const expectedContextId = (await (await fetch(base + '/codex-api/delivery-context')).json()).data.contextId
        const text = 'Reply OK. Do not use tools.'
        await post('/codex-api/delivery', { protocol: 2, threadId: id, expectedContextId, message: { id: `d-${Date.now()}-${randomUUID()}`, text }, params: { threadId: id, input: [{ type: 'text', text, text_elements: [] }] } })
        let turn
        for (let i = 0; i < 100; i++) { await delay(1000); turn = (await rpc('thread/read', { threadId: id, includeTurns: true })).thread.turns?.at(-1); if (turn?.status === 'failed') break }
        assert.equal(turn?.status, 'failed', 'invalid auth produces a persistent native failure')
        assert.ok(turn.error?.message)
        assert.match(turn.error.message, /401|403|unauthorized|auth refresh|authentication/i)
        assert.doesNotMatch(turn.error.message, /UnknownIssuer|certificate/i)
        row.failureClass = /401/.test(turn.error.message) ? '401' : /403/.test(turn.error.message) ? '403' : 'authentication'
        row.systemCaBundleMounted = true
        row.nativeFailure = true
        browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
        row.url = base + '/#/thread/' + id
        await page.goto(row.url)
        await page.locator('.turn-error-feedback').first().waitFor({ timeout: 45000 })
        await page.reload()
        await page.locator('.turn-error-feedback').first().waitFor({ timeout: 45000 })
        row.persistedAfterReload = true
        row.duplicateLiveOverlayCount = await page.locator('.live-overlay-error').count()
        assert.equal(row.duplicateLiveOverlayCount, 0)
        row.screenshots = []
        for (const dark of [false, true]) {
          await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
          await delay(2300)
          const screenshot = path.resolve(`output/playwright/0219-packaged-invalid-auth-${dark ? 'dark' : 'light'}.png`)
          await page.screenshot({ path: screenshot })
          row.screenshots.push(screenshot)
        }
        assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), before)
        row.authUnchanged = true
        await browser.close(); browser = undefined
      }
      report.cases.push(row)
      console.log(JSON.stringify(row))
    }
    report.passed = true
  } finally {
    await browser?.close()
    for (const container of containers.reverse()) docker('rm', '-f', container)
    await fs.rm(root, { recursive: true, force: true })
    report.temporaryResourcesRemoved = true
    await fs.writeFile('output/0219-final/packaged-provider-matrix.json', JSON.stringify(report, null, 2))
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
