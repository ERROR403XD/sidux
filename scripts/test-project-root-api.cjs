// Build first. Uses a disposable CODEX_HOME and real HTTP/filesystem effects.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexapp-project-api-'))
  const home = path.join(root, 'home')
  const target = path.join(root, 'target')
  const denied = path.join(root, 'denied')
  let child
  const measurements = []
  try {
    await fs.chmod(root, 0o777)
    await fs.mkdir(home, { mode: 0o777 })
    await fs.chmod(home, 0o777)
    await fs.mkdir(denied, { mode: 0o700 })
    const listener = net.createServer()
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    // On Linux root, run as nobody to exercise EACCES against our own fixture.
    const unprivileged = process.env.CODEXAPP_TEST_UNPRIVILEGED === '1' && process.platform === 'linux' && process.getuid?.() === 0
    const node = process.execPath
    child = spawn(node, [process.env.CODEXAPP_TEST_CLI || path.resolve(__dirname, '../dist-cli/index.js'), '--port', String(port), '--strict-port', '--no-password', '--no-open'], {
      cwd: root,
      env: { PATH: process.env.PATH, CODEX_HOME: home, LANG: 'C.UTF-8' },
      ...(unprivileged ? { uid: 65534, gid: 65534 } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let startup = ''
    child.stdout.on('data', data => { startup = (startup + data).slice(-4000) })
    child.stderr.on('data', data => { startup = (startup + data).slice(-4000) })
    child.on('error', error => { startup = error.message })
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`CLI exited: ${startup}`)
      try { ready = (await fetch(base)).ok } catch {}
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(ready, `CLI readiness: ${startup}`)
    async function request(route, body) {
      const start = performance.now()
      const response = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
      const text = await response.text()
      measurements.push({ route, status: response.status, ms: Math.round((performance.now() - start) * 10) / 10, bytes: Buffer.byteLength(text) })
      return { status: response.status, body: JSON.parse(text) }
    }
    const create = (p, label) => request('/codex-api/project-root', { path: p, createIfMissing: true, label })
    assert.equal((await create(target, '我的 / 机器人')).status, 200)
    assert.equal((await fs.stat(target)).isDirectory(), true)
    assert.deepEqual(await fs.readdir(target), [])
    await fs.writeFile(path.join(target, 'keep.txt'), 'existing content')
    assert.equal((await create(target, '重命名显示名')).status, 200)
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'existing content')
    assert.equal((await create(path.join(root, 'another'), '重命名显示名')).status, 200)
    const state = (await request('/codex-api/workspace-roots-state')).body.data
    assert.equal(state.order.filter(p => p === target).length, 1)
    assert.equal(state.labels[target], '重命名显示名')
    const persisted = JSON.parse(await fs.readFile(path.join(home, '.codex-global-state.json'), 'utf8'))
    assert.equal(persisted['electron-workspace-root-labels'][target], '重命名显示名')
    assert.equal((await create(path.join(target, 'keep.txt'), 'file')).status, 400)
    if (unprivileged) {
      const failure = await create(path.join(denied, 'child'), 'denied')
      assert.ok(failure.status >= 400)
      assert.match(failure.body.error, /EACCES|permission denied/i)
      assert.ok(!(await request('/codex-api/workspace-roots-state')).body.data.order.includes(path.join(denied, 'child')))
    }
    const folder = path.join(target, 'child-folder')
    assert.equal((await request('/codex-api/local-directory', { path: folder })).status, 200)
    assert.equal((await fs.stat(folder)).isDirectory(), true)
    if (process.env.CODEXAPP_TEST_GITHUB_CLONE === '1') {
      const cloneBase = path.join(root, 'clone-parent')
      await fs.mkdir(cloneBase)
      await fs.chmod(cloneBase, 0o777)
      const cloned = await request('/codex-api/github-clone', { url: 'https://github.com/octocat/Hello-World.git', basePath: cloneBase })
      assert.equal(cloned.status, 200, JSON.stringify(cloned.body))
      assert.equal(cloned.body.data.path, path.join(cloneBase, 'Hello-World'))
      assert.ok((await fs.stat(path.join(cloned.body.data.path, '.git'))).isDirectory())
      const invalid = await request('/codex-api/github-clone', { url: 'https://example.com/repo.git', basePath: cloneBase })
      assert.equal(invalid.status, 400)
    }
    console.log(JSON.stringify({ passed: true, port, permissionTest: unprivileged ? 'EACCES verified' : 'pending: run CODEXAPP_TEST_UNPRIVILEGED=1 inside packed-image container', cloneTest: process.env.CODEXAPP_TEST_GITHUB_CLONE === '1' ? 'passed' : 'not requested', measurements }, null, 2))
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 3000).unref() })
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
