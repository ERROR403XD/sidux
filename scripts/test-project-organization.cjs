// Build first. All metadata and sessions are fixtures in a disposable CODEX_HOME.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const net = require('node:net')

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexapp-project-organization-'))
  const home = path.join(root, 'home')
  await fs.mkdir(home)
  const createdDirectories = new Set()
  const marker = `codexapp-org-${randomUUID().slice(0, 8)}`
  const report = { cases: [], requests: [], passed: false }
  let child
  let base
  async function start() {
    const listener = net.createServer()
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [path.resolve('dist-cli/index.js'), '--port', String(port), '--strict-port', '--no-password', '--no-open'], {
      cwd: root, env: { PATH: process.env.PATH, CODEX_HOME: home, CODEXUI_CODEX_COMMAND: path.resolve('src/server/fixtures/account-app-server.cjs'), LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    child.stdout.on('data', data => { logs = (logs + data).slice(-4000) })
    child.stderr.on('data', data => { logs = (logs + data).slice(-4000) })
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Fixture exited: ${logs}`)
      try { if ((await fetch(base)).ok) return } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Fixture startup timeout')
  }
  async function stop() {
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000).unref() })
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
  async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
    const start = performance.now()
    const response = await fetch(base + route, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const raw = await response.text()
    report.requests.push({ route: route.split('?')[0], method, status: response.status, ms: Math.round((performance.now() - start) * 10) / 10, bytes: Buffer.byteLength(raw) })
    assert.equal(response.status, 200, `${route}: ${raw}`)
    return JSON.parse(raw).data
  }
  const create = (label, id = '') => request('/codex-api/project-root', { path: id, label, createIfMissing: true })
  try {
    await start()
    const physical = path.join(root, 'real-project')
    await request('/codex-api/project-root', { path: physical, label: '真实项目', createIfMissing: true })
    await fs.writeFile(path.join(physical, 'unchanged.md'), 'physical project unchanged')
    const before = await fs.readdir(root)
    const name = '组织 / 项目 <test>'
    const first = await create(name)
    const second = await create(name)
    assert.notEqual(first.path, second.path)
    assert.match(first.path, /^virtual:/)
    assert.deepEqual(await fs.readdir(root), before)
    let state = await request('/codex-api/workspace-roots-state')
    assert.deepEqual(state.order, [physical])
    assert.deepEqual(state.virtualProjects.map(project => project.label), [name, name])
    report.cases.push('name-only create: no workspace created; duplicate names retain separate identities')

    // This endpoint creates the same normal projectless cwd as an ungrouped chat.
    const directory = await request('/codex-api/projectless-thread-cwd', { prompt: marker, projectId: first.path })
    createdDirectories.add(directory.cwd)
    assert.ok(directory.cwd.includes('/Documents/Codex/'))
    assert.ok(path.basename(directory.cwd).startsWith(marker))
    assert.deepEqual(await fs.readdir(directory.cwd), [])
    await fs.writeFile(path.join(directory.cwd, 'result.md'), 'ORGANIZATION_EXPORT_FIXTURE')
    const alias = directory.cwd + '-alias'
    await fs.symlink(directory.cwd, alias)
    createdDirectories.add(alias)
    const threadId = randomUUID()
    const sessions = path.join(home, 'sessions', '2026', '09', '13')
    await fs.mkdir(sessions, { recursive: true })
    const sessionPath = path.join(sessions, `rollout-fixture-${threadId}.jsonl`)
    const session = JSON.stringify({ timestamp: '2026-09-13T00:00:00Z', type: 'session_meta', payload: { id: threadId, cwd: alias, model_provider: 'fixture' } }) + '\n'
      + JSON.stringify({ timestamp: '2026-09-13T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] } }) + '\n'
    await fs.writeFile(sessionPath, session)
    await create('Renamed', first.path)
    await request('/codex-api/project-membership', { cwd: directory.cwd, projectId: second.path })
    assert.equal(await fs.readFile(sessionPath, 'utf8'), session)
    assert.deepEqual(await fs.readdir(directory.cwd), ['result.md'])
    state = await request('/codex-api/workspace-roots-state')
    assert.deepEqual(state.virtualProjects.find(project => project.id === second.path).cwds, [directory.cwd])
    assert.deepEqual(state.virtualProjects.find(project => project.id === first.path).cwds, [])
    report.cases.push('rename/move preserves native session bytes, cwd, files and absence of AGENTS.md')

    const listing = await (await fetch(base + '/codex-api/project-files?' + new URLSearchParams({ id: second.path }))).text()
    assert.ok(listing.includes(encodeURI(directory.cwd)))
    assert.ok(listing.includes('&lt;test&gt;'))
    assert.ok(!listing.includes('Open current folder in Codex'))
    const zip = await fetch(base + '/codex-api/project-zip?' + new URLSearchParams({ cwd: second.path }))
    assert.equal(zip.status, 200)
    const archive = Buffer.from(await zip.arrayBuffer())
    assert.ok(archive.includes(Buffer.from('ORGANIZATION_EXPORT_FIXTURE')))
    const imported = await fetch(base + '/codex-api/project-import?' + new URLSearchParams({ parent: root }), { method: 'POST', body: archive })
    assert.equal(imported.status, 200, await imported.clone().text())
    const importedData = (await imported.json()).data
    assert.match(importedData.path, /^virtual:/)
    assert.equal(importedData.importedSessions, 1)
    state = await request('/codex-api/workspace-roots-state')
    const restored = state.virtualProjects.find(project => project.id === importedData.path)
    assert.equal(restored.label, name)
    assert.equal(restored.cwds.length, 1)
    for (const cwd of restored.cwds) createdDirectories.add(cwd)
    assert.notEqual(restored.cwds[0], directory.cwd)
    assert.equal(await fs.readFile(path.join(restored.cwds[0], 'result.md'), 'utf8'), 'ORGANIZATION_EXPORT_FIXTURE')
    assert.deepEqual(state.order, [physical])
    assert.equal(await fs.readFile(sessionPath, 'utf8'), session)
    report.cases.push('file browser and ZIP round trip retain organization, member files and independent imported sessions')

    const emptyZip = await fetch(base + '/codex-api/project-zip?' + new URLSearchParams({ cwd: first.path }))
    assert.equal(emptyZip.status, 200)
    assert.ok(Buffer.from(await emptyZip.arrayBuffer()).includes(Buffer.from('manifest.json')))
    await stop()
    await start()
    state = await request('/codex-api/workspace-roots-state')
    assert.deepEqual(state.virtualProjects.find(project => project.id === second.path).cwds, [directory.cwd])
    await request('/codex-api/project-root?' + new URLSearchParams({ id: second.path }), undefined, 'DELETE')
    assert.equal(await fs.readFile(sessionPath, 'utf8'), session)
    assert.equal(await fs.readFile(path.join(directory.cwd, 'result.md'), 'utf8'), 'ORGANIZATION_EXPORT_FIXTURE')
    assert.equal(await fs.readFile(path.join(physical, 'unchanged.md'), 'utf8'), 'physical project unchanged')
    state = await request('/codex-api/workspace-roots-state')
    assert.ok(!state.virtualProjects.some(project => project.id === second.path))
    assert.deepEqual(state.order, [physical])
    report.cases.push('empty export, process restart and remove preserve all native workspaces and sessions')
    report.passed = true
  } finally {
    await stop()
    for (const cwd of createdDirectories) {
      assert.ok(path.basename(cwd).startsWith(marker), 'cleanup only explicitly returned fixture directories')
      await fs.rm(cwd, { recursive: true, force: true })
    }
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir('output/0219-final', { recursive: true })
    await fs.writeFile(process.env.UI_REPORT_PATH || 'output/0219-final/project-http.json', JSON.stringify(report, null, 2))
  }
  console.log(JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
