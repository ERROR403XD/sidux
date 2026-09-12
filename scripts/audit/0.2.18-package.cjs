const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const release = '/home/docker/codexapp-releases/codexapp-0.2.18-f9a3b9494893-20260912-162826';
const previous = '/home/docker/codexapp-releases/codexapp-0.2.17-ac78f492f7d2-20260911-204236';
const base = 'http://127.0.0.1:59015';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexapp-0218-package-'));
const report = { release, previous, base, viewport: { width: 1440, height: 1000 } };
let child, browser;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function files(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(folder, entry.name)).map(name => path.join(entry.name, name)) : [entry.name]);
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
    throw new Error('Port 59015 is already occupied; refusing to reuse it');
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  const log = fs.openSync(path.join(root, path.basename(directory) + '.log'), 'a');
  const env = { ...process.env, CODEX_HOME: path.join(root, 'home'), CODEXAPP_API_PROXY_BINARY: path.join(directory, 'api-proxy-component/cli-proxy-api') };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  child = spawn(process.execPath, [path.join(directory, 'dist-cli/index.js'), '--port', '59015', '--strict-port', '--no-password', '--no-open'], {
    cwd: directory, env,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  for (let n = 0; n < 100; n++) {
    assert.equal(child.exitCode, null, 'smoke server exited');
    try { if ((await fetch(base + '/')).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('smoke server not ready');
}
async function main() {
  let count = 0;
  for (const folder of ['dist', 'dist-cli']) for (const name of files(path.join(release, folder))) {
    assert.deepEqual(fs.readFileSync(path.join(release, folder, name)), fs.readFileSync(path.join(process.cwd(), folder, name)));
    count++;
  }
  report.matchingArtifacts = count;
  const pty = require(path.join(release, 'node_modules/node-pty'));
  assert.equal(typeof pty.spawn, 'function');
  await new Promise((resolve, reject) => {
    const term = pty.spawn('/bin/sh', ['-c', 'printf PREPARED_PTY_OK'], { name: 'xterm-color', cols: 80, rows: 24, cwd: root, env: { PATH: process.env.PATH, TERM: 'xterm-color' } });
    let output = '';
    const timer = setTimeout(() => { term.kill(); reject(new Error('PTY timeout')); }, 5000);
    term.onData(data => output += data);
    term.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); assert.match(output, /PREPARED_PTY_OK/); resolve(); } catch (error) { reject(error); } });
  });
  report.pty = 'PREPARED_PTY_OK';
  await start(previous);
  browser = await chromium.launch({ headless: true, executablePath: '/snap/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: report.viewport });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  const oldHtml = await (await fetch(base)).text();
  const oldAsset = oldHtml.match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
  await stop();
  await start(release);
  const reload = await page.reload({ waitUntil: 'networkidle' });
  assert.equal(reload.status(), 200);
  const headers = reload.headers();
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers.etag, undefined);
  assert.equal(headers['last-modified'], undefined);
  const html = await (await fetch(base, { headers: { 'If-None-Match': 'W/"old-release"', 'If-Modified-Since': new Date().toUTCString() } })).text();
  const newAsset = html.match(/src="(\/assets\/index-[^"]+\.js)"/)[1];
  assert.notEqual(oldAsset, newAsset);
  assert.equal((await fetch(base + oldAsset)).status, 404);
  assert.match((await fetch(base + newAsset)).headers.get('cache-control'), /immutable/);
  const capability = await page.evaluate(async () => (await (await fetch('/codex-api/meta/capabilities')).json()).data);
  assert.equal(capability.appVersion, '0.2.18');
  report.cache = { oldAsset, newAsset, entryNoStore: true, noEtag: true, oldAsset404: true, version: capability.appVersion };
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'output/playwright/0218-prepared-cache.png', fullPage: true });
  const sample = path.join(root, 'preview.html');
  const target = path.join(root, 'preview-target.txt');
  fs.writeFileSync(target, 'before');
  fs.writeFileSync(sample, '<!doctype html><h1>Isolated preview boundary probe</h1><pre id="result"></pre><script>(async()=>{const a=await fetch("/codex-api/meta/capabilities");const v=(await a.json()).data.appVersion;const b=await fetch('+JSON.stringify('/codex-local-edit' + target)+',{method:"PUT",body:"AUDIT_TEST_ONLY",headers:{"Content-Type":"text/plain"}});window.probe={apiStatus:a.status,version:v,writeStatus:b.status};document.getElementById("result").textContent=JSON.stringify(window.probe)})()</script>');
  const response = await page.goto(base + '/codex-local-browse' + sample, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.probe);
  report.previewBoundary = await page.evaluate(() => window.probe);
  report.previewBoundary.csp = response.headers()['content-security-policy'] || null;
  report.previewBoundary.temporaryFileChanged = fs.readFileSync(target, 'utf8') === 'AUDIT_TEST_ONLY';
  assert.equal(report.previewBoundary.apiStatus, 200);
  assert.equal(report.previewBoundary.writeStatus, 200);
  assert.equal(report.previewBoundary.temporaryFileChanged, true);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'output/playwright/0218-preview-boundary.png', fullPage: true });
  const missingKey = await fetch(base + '/v1/models');
  assert.equal(missingKey.status, 401);
  report.apiWithoutKey = 401;
  report.tarballSha256 = execFileSync('sha256sum', ['/tmp/codexapp-0.2.18.tgz'], { encoding: 'utf8' }).split(' ')[0];
}
main().then(() => { report.passed = true; }).catch(error => { report.error = error.message; process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await stop();
  fs.rmSync(root, { recursive: true, force: true });
  report.temporaryResourcesRemoved = true;
  fs.writeFileSync('output/0218/prepared-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
});
