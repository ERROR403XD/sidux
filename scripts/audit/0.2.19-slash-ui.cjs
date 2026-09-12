const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const base = process.env.UI_BASE_URL || 'http://127.0.0.1:4173';
  const label = process.env.UI_LABEL || 'dev';
  const report = { base, label, screenshots: [], cases: [], errors: [], turnStarts: 0 };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', req => { if (req.url().endsWith('/codex-api/rpc') && req.method() === 'POST') { try { if (req.postDataJSON()?.method === 'turn/start') report.turnStarts++; } catch {} } });
    await page.addInitScript(() => localStorage.setItem('codex-web-local.ui-language.v1', 'zh-CN'));
    await page.goto(base + '/#/');
    const input = page.locator('textarea.thread-composer-input');
    const picker = page.locator('.composer-command-picker');
    await input.waitFor();
    for (const prefix of ['已有内容', 'hello ', '第一行\n', ' ', '/plan ', 'https://example.com', '/tmp/folder']) {
      await input.fill(prefix);
      await input.press('ControlOrMeta+End');
      await input.pressSequentially('/plan');
      await page.waitForTimeout(100);
      assert.equal(await picker.count(), 0, prefix);
      assert.equal(await input.inputValue(), prefix + '/plan');
      report.cases.push(prefix + '/plan: literal');
    }
    for (const [width, height] of [[1440, 1000], [375, 812], [768, 1024]]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(d => document.documentElement.classList.toggle('dark', d), dark);
      await input.fill('');
      await input.pressSequentially('/');
      await picker.waitFor();
      assert(await picker.getByRole('option').count() > 0);
      await page.waitForTimeout(2300);
      const rect = await picker.boundingBox();
      assert(rect && rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= height + 1);
      const shot = `output/playwright/0219-slash-${label}-${width}-${dark ? 'dark' : 'light'}.png`;
      await page.screenshot({ path: shot });
      report.screenshots.push({ path: shot, width, height, dark });
      await input.press('Escape');
      assert.equal(await picker.count(), 0);
      await input.fill('');
      await input.pressSequentially('/zzzznonexistent');
      await picker.waitFor();
      assert.equal(await page.locator('.composer-command-empty').innerText(), '无匹配命令');
      if (width === 1440) {
        await page.waitForTimeout(2300);
        const emptyShot = `output/playwright/0219-slash-empty-${label}-${dark ? 'dark' : 'light'}.png`;
        await page.screenshot({ path: emptyShot });
        report.screenshots.push({ path: emptyShot, width, height, dark });
        const detail = `output/playwright/0219-slash-empty-detail-${label}-${dark ? 'dark' : 'light'}.png`;
        await picker.screenshot({ path: detail });
        report.screenshots.push({ path: detail, width, height, dark, element: '.composer-command-picker' });
      }
      await input.press('Escape');
    }
    // Language is context-local. No saved server preference or account is changed.
    const english = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await english.addInitScript(() => localStorage.setItem('codex-web-local.ui-language.v1', 'en'));
    await english.goto(base + '/#/');
    const englishInput = english.locator('textarea.thread-composer-input');
    await englishInput.waitFor();
    await englishInput.fill('');
    await englishInput.pressSequentially('/zzzznonexistent');
    await english.locator('.composer-command-empty').waitFor();
    assert.equal(await english.locator('.composer-command-empty').innerText(), 'No matching commands');
    await input.fill('');
    await englishInput.fill('');
    assert.deepEqual(report.errors, []);
    assert.equal(report.turnStarts, 0);
    report.passed = true;
  } finally {
    await browser.close();
    fs.writeFileSync(`output/0219/slash-${label}-ui.json`, JSON.stringify(report, null, 2));
  }
  console.log(`SLASH_UI_PASS ${base}, 6 viewports/themes, no sends`);
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
