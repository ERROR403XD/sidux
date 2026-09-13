const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { spawn, execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const run = promisify(execFile);
const release = '/home/docker/codexapp-releases/codexapp-0.2.19-0612357254c4-20260913-101637';
const previous = '/home/docker/codexapp-releases/codexapp-0.2.18-6ad0e99242c8-20260912-221253';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexapp-0219-smoke-'));
const base = 'http://127.0.0.1:59015';
const report = { release, previous, base, node: process.version };
let child, browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function files(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(folder, e.name)).map(f => path.join(e.name, f)) : [e.name]);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const proc = child;
  const done = new Promise(resolve => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await Promise.race([done, delay(8000).then(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); })]);
  await done;
  child = null;
}
async function start(directory) {
  try {
    execFileSync('lsof', ['-nP', '-iTCP:59015', '-sTCP:LISTEN'], { stdio: 'pipe' });
    throw new Error('59015 already occupied');
  } catch (e) { if (e.status !== 1) throw e; }
  const log = fs.openSync(path.join(root, path.basename(directory) + '.log'), 'a');
  const env = { ...process.env, CODEX_HOME: path.join(root, 'home'), CODEXAPP_API_PROXY_BINARY: path.join(directory, 'api-proxy-component/cli-proxy-api') };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  child = spawn(process.execPath, [path.join(directory, 'dist-cli/index.js'), '--port', '59015', '--strict-port', '--no-password', '--no-open'], { cwd: directory, env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  for (let i = 0; i < 150; i++) {
    assert.equal(child.exitCode, null, 'smoke server exited');
    try { if ((await fetch(base + '/')).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('smoke server did not start');
}
async function cjsAndPty(directory) {
  const req = createRequire(path.join(directory, 'package.json'));
  assert.equal(typeof req('express'), 'function');
  assert.equal(typeof req('ws').WebSocketServer, 'function');
  const pty = req('node-pty');
  assert.equal(typeof pty.spawn, 'function');
  await new Promise((resolve, reject) => {
    const term = pty.spawn('/bin/sh', ['-c', 'printf PREPARED_PTY_OK'], { name: 'xterm-color', cols: 80, rows: 24, cwd: root, env: { PATH: process.env.PATH, TERM: 'xterm-color' } });
    let output = '';
    const timer = setTimeout(() => { term.kill(); reject(new Error('PTY timeout')); }, 5000);
    term.onData(data => output += data);
    term.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); assert.match(output, /PREPARED_PTY_OK/); resolve(); } catch (e) { reject(e); } });
  });
}
function installedVersions(directory, lock) {
  const rows = {};
  for (const [p, info] of Object.entries(lock.packages)) {
    if (!p || info.dev === true) continue;
    const actual = JSON.parse(fs.readFileSync(path.join(directory, p, 'package.json'), 'utf8'));
    assert.equal(actual.version, info.version, p);
    rows[p] = actual.version;
  }
  return rows;
}
async function main() {
  let count = 0;
  for (const folder of ['dist', 'dist-cli']) for (const name of files(path.join(release, folder))) {
    assert.deepEqual(fs.readFileSync(path.join(release, folder, name)), fs.readFileSync(path.join(process.cwd(), folder, name)));
    count++;
  }
  report.matchingArtifacts = count;
  assert.match(execFileSync(process.execPath, [path.join(release, 'dist-cli/index.js'), '--help'], { encoding: 'utf8' }), /--port/);
  await cjsAndPty(release);
  report.cjsAndPty = 'PREPARED_PTY_OK';
  const lockPath = path.join(release, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(release, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.19');
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) assert.equal(lock.packages['node_modules/' + name].version, version, name);
  const versions = installedVersions(release, lock);
  const replay = path.join(root, 'replay');
  fs.mkdirSync(replay);
  execFileSync('tar', ['-xzf', '/tmp/codexapp-0.2.19.tgz', '-C', replay, '--strip-components=1']);
  fs.copyFileSync(lockPath, path.join(replay, 'package-lock.json'));
  const ci = await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: replay, timeout: 120000, maxBuffer: 2000000 });
  fs.writeFileSync('output/0219-revision/npm-ci.log', ci.stdout + ci.stderr);
  assert.equal(hash(lockPath), hash(path.join(replay, 'package-lock.json')));
  assert.deepEqual(installedVersions(replay, lock), versions);
  await cjsAndPty(replay);
  report.lockReplay = { dependencyPackages: Object.keys(versions).length, lockUnchanged: true, installedVersionsMatch: true, pty: 'PREPARED_PTY_OK' };
  report.tarballSha256 = hash('/tmp/codexapp-0.2.19.tgz');
  report.lockSha256 = hash(lockPath);
  await start(previous);
  browser = await chromium.launch({ headless: true, executablePath: '/snap/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(base, { waitUntil: 'networkidle' });
  const oldAsset = (await (await fetch(base)).text()).match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
  await stop();
  await start(release);
  const reload = await page.reload({ waitUntil: 'networkidle' });
  assert.equal(reload.status(), 200);
  assert.equal(reload.headers()['cache-control'], 'no-store');
  assert.equal(reload.headers().etag, undefined);
  assert.equal(reload.headers()['last-modified'], undefined);
  const html = await (await fetch(base, { headers: { 'If-None-Match': 'W/"old-release"', 'If-Modified-Since': new Date().toUTCString() } })).text();
  const newAsset = html.match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
  assert.notEqual(oldAsset, newAsset);
  assert.equal((await fetch(base + oldAsset)).status, 404);
  assert.match((await fetch(base + newAsset)).headers.get('cache-control'), /immutable/);
  const capability = (await (await fetch(base + '/codex-api/meta/capabilities')).json()).data;
  assert.equal(capability.appVersion, '0.2.19');
  report.cache = { oldAsset, newAsset, entryNoStore: true, noEtag: true, oldAsset404: true, version: capability.appVersion };
  report.apiWithoutKey = (await fetch(base + '/v1/models')).status;
  assert.equal(report.apiWithoutKey, 401);
  report.activation = (await (await fetch(base + '/codex-api/api-proxy/activation/activity')).json()).data;
  assert.equal(report.activation.ready, true);
  assert.equal(report.activation.draining, false);
  assert.equal(report.activation.activeCount, 0);
}
main().then(() => { report.passed = true; }).catch(e => { report.error = e.message; process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
  report.temporaryResourcesRemoved = true;
  fs.writeFileSync('output/0219-revision/prepared-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
});
