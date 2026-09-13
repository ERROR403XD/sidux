const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
(async () => {
  const base = 'http://127.0.0.1:59001';
  const report = { base, viewport: { width: 1440, height: 1000 }, errors: [], requests: [] };
  const capability = (await (await fetch(base + '/codex-api/meta/capabilities')).json()).data;
  assert.equal(capability.appVersion, '0.2.19');
  report.version = capability.appVersion;
  const html = await (await fetch(base)).text();
  const manifestPath = html.match(/<link[^>]*rel="manifest"[^>]*href="([^"]+)"/)?.[1];
  assert.ok(manifestPath);
  const manifest = await (await fetch(new URL(manifestPath, base))).json();
  assert.equal(manifest.launch_handler.client_mode, 'focus-existing');
  report.manifest = { path: manifestPath, launch_handler: manifest.launch_handler };
  report.interruptionsStatus = (await fetch(base + '/codex-api/thread-interruptions')).status;
  assert.equal(report.interruptionsStatus, 200);
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: report.viewport });
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', req => { if(req.url().endsWith('/codex-api/rpc') && req.method()==='POST') report.requests.push(req.postDataJSON().method); });
    await page.goto(base);
    await page.locator('.thread-composer-input').waitFor();
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(2500);
    assert.equal(await page.locator('#app-load-recovery:visible').count(), 0);
    assert.deepEqual(report.errors, []);
    assert.ok(!report.requests.some(m => /turn\/(start|interrupt)|account\/login/.test(m)));
    report.screenshot = '/home/Code/codexapp/output/playwright/0219-revision-candidate-dark.png';
    // Capture the actual application surface without including private account
    // details or conversation titles from this isolated candidate's sidebar.
    report.screenshotScope = 'Main content only; account and session sidebar excluded';
    await page.screenshot({ path: report.screenshot, clip: { x: 261, y: 0, width: 1179, height: 1000 } });
    report.passed = true;
  } finally { await browser.close(); fs.writeFileSync('output/0219-revision/candidate-check.json', JSON.stringify(report,null,2)); }
})().catch(e => { console.error(e.message); process.exitCode=1; });
