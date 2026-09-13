// Build first. Regression: removing UI organization preserves automation execution and identity.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const net = require('node:net')

async function main() {
  const reportPath = process.env.UI_REPORT_PATH || 'output/0219-revision/virtual-automation.json'
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexapp-review-virtual-'))
  const home = path.join(root, 'home')
  await fs.mkdir(home)
  const marker = `codexapp-review-${randomUUID()}`
  const credential = { auth_mode: 'chatgpt', tokens: {
    account_id: 'review-fixture', refresh_token: 'synthetic-fixture',
    access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 86400,
      'https://api.openai.com/auth': { chatgpt_account_id: 'review-fixture', user_id: 'review-fixture' },
    })).toString('base64url') + '.signature',
  } }
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(credential), { mode: 0o600 })
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const cli = path.resolve('dist-cli/index.js')
  const child = spawn(process.execPath, [cli, '--port', String(port), '--strict-port', '--no-password', '--no-open'], {
    cwd: root, env: { PATH: process.env.PATH, CODEX_HOME: home,
      CODEXUI_CODEX_COMMAND: path.resolve('src/server/fixtures/account-app-server.cjs'), LANG: 'C.UTF-8' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const created = new Set()
  const report = { fixturePort: port, cliSha256: createHash('sha256').update(await fs.readFile(cli)).digest('hex'), requests: [], passed: false }
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(5000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const payload = await response.json()
    report.requests.push({ route: route.split('?')[0], method, status: response.status })
    assert.equal(response.status, 200, JSON.stringify(payload))
    return payload.data ?? payload
  }
  async function run(id, projectName, requestId, retryOf) {
    const queued = await request('/codex-api/project-automation/run', { automationId: id, projectName, requestId, retryOf })
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await request('/codex-api/automation-runs?' + new URLSearchParams({ automationId: id }))
      const row = rows.find(run => run.runId === queued.run.runId)
      if (row && ['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status)) return row
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Fixture task did not settle')
  }
  try {
    let started = false
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error('Fixture exited')
      try { if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) { started = true; break } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(started)
    const project = await request('/codex-api/project-root', { label: marker, path: '' })
    const automation = await request('/codex-api/project-automation', {
      projectName: project.path, name: marker, prompt: 'isolated fixture', model: 'fixture',
      rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', status: 'PAUSED',
    }, 'PUT')
    const before = await run(automation.id, project.path, 'before-removal')
    report.beforeRemoval = { status: before.status, errorCode: before.errorCode }
    assert.equal(before.status, 'completed')
    const projects = JSON.parse(await fs.readFile(path.join(home, 'codexapp-projects.json'), 'utf8'))
    projects.projects.find(item => item.id === project.path).cwds.forEach(cwd => created.add(cwd))
    const definitionBefore = await fs.readFile(path.join(home, 'automations', automation.id, 'automation.toml'), 'utf8')
    const authBefore = await fs.readFile(path.join(home, 'auth.json'), 'utf8')
    await request('/codex-api/project-root?' + new URLSearchParams({ id: project.path }), undefined, 'DELETE')
    const retained = await request('/codex-api/project-automations')
    report.definitionRetainedAfterRemoval = retained[project.path]?.some(item => item.id === automation.id)
    const after = await run(automation.id, project.path, 'after-removal')
    report.afterRemoval = { status: after.status, errorCode: after.errorCode, error: after.error }
    assert.equal(after.status, 'completed')
    assert.ok(report.definitionRetainedAfterRemoval)
    assert.equal(after.executionAccountStorageId, before.executionAccountStorageId)
    assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), authBefore)
    assert.equal(await fs.readFile(path.join(home, 'automations', automation.id, 'automation.toml'), 'utf8'), definitionBefore)
    assert.equal((await run(automation.id, project.path, 'after-removal')).runId, after.runId)
    const memberships = JSON.parse(await fs.readFile(path.join(home, 'codexapp-projects.json'), 'utf8'))
    assert.ok(!memberships.projects.some(item => item.id === project.path))
    const output = JSON.parse(await fs.readFile(path.join(home, `fixture-thread-${after.threadId}.json`), 'utf8'))
    assert.ok(output.cwd.includes('/Documents/Codex/'))
    assert.ok(!memberships.projects.some(item => item.cwds.includes(output.cwd)))
    assert.equal(output.turns.length, 1)
    report.definitionAndAccountUnchanged = true
    report.originalIdentityReused = true
    report.resultUngrouped = true

    const retry = await run(automation.id, project.path, 'retry-after-removal', after.runId)
    assert.equal(retry.status, 'completed')
    assert.equal(retry.trigger, 'retry')
    assert.equal(retry.retryOf, after.runId)
    assert.equal(retry.attempt, after.attempt + 1)
    assert.notEqual(retry.runId, after.runId)
    assert.equal((await run(automation.id, project.path, 'retry-after-removal', after.runId)).runId, retry.runId)
    report.explicitRetryPreservesIdentity = true

    assert.ok(typeof before.executionAccountStorageId === 'string' && before.executionAccountStorageId)
    const scheduledDefinition = {
      id: automation.id, projectName: project.path, name: marker, prompt: 'isolated fixture', model: 'fixture',
      rrule: 'FREQ=MINUTELY;INTERVAL=1', accountStorageId: before.executionAccountStorageId,
    }
    await request('/codex-api/project-automation', { ...scheduledDefinition, status: 'ACTIVE' }, 'PUT')
    let scheduled
    // Exercise the real timer and resolver, without manipulating scheduler state
    // or the wall clock. Only this disposable fixture can create new runs.
    for (let attempt = 0; attempt < 80; attempt++) {
      const rows = await request('/codex-api/automation-runs?' + new URLSearchParams({ automationId: automation.id }))
      scheduled = rows.find(row => row.trigger === 'schedule' && ['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status))
      if (scheduled) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    assert.ok(scheduled, 'natural minute trigger must complete within 80 seconds')
    assert.equal(scheduled.status, 'completed')
    assert.equal(scheduled.executionAccountStorageId, before.executionAccountStorageId)
    const scheduledOutput = JSON.parse(await fs.readFile(path.join(home, `fixture-thread-${scheduled.threadId}.json`), 'utf8'))
    assert.equal(scheduledOutput.turns.length, 1)
    await request('/codex-api/project-automation', { ...scheduledDefinition, status: 'PAUSED' }, 'PUT')
    const paused = (await request('/codex-api/project-automations'))[project.path].find(row => row.id === automation.id)
    assert.equal(paused.status, 'PAUSED')
    assert.equal(paused.nextRunAtMs, null)
    assert.equal(paused.accountStorageId, before.executionAccountStorageId)
    assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), authBefore)
    const finalMemberships = JSON.parse(await fs.readFile(path.join(home, 'codexapp-projects.json'), 'utf8'))
    assert.ok(!finalMemberships.projects.some(item => item.id === project.path || item.cwds.includes(scheduledOutput.cwd)))
    report.naturalScheduleAfterRemoval = { status: scheduled.status, trigger: scheduled.trigger, fixedAccountPreserved: true, singleTurn: true }
    report.pauseAndReenablePreserved = true
    report.passed = true
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null) await Promise.race([
      new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000)),
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
    }
    // Also collect paths if an assertion failed before the successful run read.
    const ownFiles = await fs.readdir(home)
    for (const filename of ownFiles.filter(name => /^fixture-thread-.*\.json$/.test(name))) {
      const thread = JSON.parse(await fs.readFile(path.join(home, filename), 'utf8'))
      if (typeof thread.cwd === 'string') created.add(thread.cwd)
    }
    try {
      const state = JSON.parse(await fs.readFile(path.join(home, 'codexapp-projects.json'), 'utf8'))
      for (const project of state.projects) for (const cwd of project.cwds) created.add(cwd)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    // Only remove paths created by this fixture and carrying its unique name.
    for (const cwd of created) {
      assert.ok(cwd.startsWith(path.join(os.homedir(), 'Documents', 'Codex') + '/'))
      const expectedSlug = marker.toLowerCase().match(/[a-z0-9]+/g).slice(0, 6).join('-').slice(0, 80)
      assert.ok(path.basename(cwd).startsWith(expectedSlug))
      await fs.rm(cwd, { recursive: true, force: true })
    }
    await fs.rm(root, { recursive: true, force: true })
    report.cleanupComplete = true
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
