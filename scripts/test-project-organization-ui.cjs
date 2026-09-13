const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { randomUUID } = require('node:crypto')

async function main() {
  const base = process.env.UI_BASE_URL || 'http://127.0.0.1:4173'
  const browser = await chromium.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const label = process.env.UI_LABEL ? process.env.UI_LABEL + '-' : ''
  const report = { base, cases: [], screenshots: [], errors: [], requests: [], boundaries: [] }
  const projectCwd = '/tmp/project-ui/Documents/Codex/2026-09-13/conversation'
  const nativeThread = { id: '11111111-1111-4111-8111-111111111111', name: 'Project UI conversation', preview: 'Project UI conversation', cwd: projectCwd, createdAt: 1789220000, updatedAt: 1789220000, status: { type: 'idle' }, source: 'cli', modelProvider: 'openai', turns: [] }
  const state = { order: ['/tmp/project-ui/real'], labels: { '/tmp/project-ui/real': 'Real project' }, active: ['/tmp/project-ui/real'], projectOrder: ['/tmp/project-ui/real'], virtualProjects: [] }
  const projectMap = {}
  let pins = []
  let page
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(() => {
      const key = 'codex-web-local.ui-language.v1'
      if (!localStorage.getItem(key)) localStorage.setItem(key, 'en')
    })
    await context.route('**/codex-api/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const name = url.pathname.slice('/codex-api/'.length)
      const body = request.postData() ? request.postDataJSON() : {}
      const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) })
      report.requests.push({ name, method: request.method(), rpc: body.method })
      if (name === 'rpc') {
        if (body.method === 'thread/list') return json({ result: { data: [nativeThread], nextCursor: null } })
        if (['thread/read', 'thread/resume'].includes(body.method)) return json({ result: { thread: nativeThread, model: 'fixture' } })
        if (body.method === 'config/read') return json({ result: { config: { model: 'fixture', model_provider: 'openai' } } })
        return json({ result: { data: [], nextCursor: null } })
      }
      if (name === 'workspace-roots-state') {
        if (request.method() === 'PUT') Object.assign(state, body, { virtualProjects: state.virtualProjects })
        return json({ data: { ...state, labels: { ...state.labels, ...Object.fromEntries(state.virtualProjects.map(project => [project.id, project.label])) } } })
      }
      if (name === 'project-root') {
        if (request.method() === 'DELETE') { state.virtualProjects = state.virtualProjects.filter(project => project.id !== url.searchParams.get('id')); return json({ ok: true }) }
        let project = state.virtualProjects.find(project => project.id === body.path)
        if (!project) { project = { id: `virtual:${randomUUID()}`, label: body.label, cwds: [] }; state.virtualProjects.push(project); state.projectOrder.unshift(project.id) }
        project.label = body.label
        return json({ data: { path: project.id } })
      }
      if (name === 'project-membership') {
        for (const project of state.virtualProjects) project.cwds = project.cwds.filter(cwd => cwd !== body.cwd)
        if (body.projectId) state.virtualProjects.find(project => project.id === body.projectId).cwds.push(body.cwd)
        return json({ ok: true })
      }
      if (name === 'project-directories') return json({ data: [] })
      if (name === 'thread-titles') return json({ data: { titles: {} } })
      if (name === 'thread-pins') { if (request.method() === 'PUT') pins = body.threadIds; return json({ data: { threadIds: pins } }) }
      if (name === 'thread-automations') return json({ data: {} })
      if (name === 'project-automations') return json({ data: projectMap })
      if (name === 'automation-runtime') return json({ data: { ready: true, draining: false, error: null, timezone: 'Asia/Shanghai', activeCount: 0, queuedCount: 0, definitions: [] } })
      if (name === 'automation-runs') return json({ data: [], nextCursor: null })
      if (name === 'project-automation') {
        if (request.method() === 'DELETE') { delete projectMap[url.searchParams.get('projectName')]; return json({ data: { removed: true } }) }
        const automation = { ...body, id: body.id || 'ui-automation', kind: 'cron', cwds: [body.projectName], createdAtMs: Date.now(), updatedAtMs: Date.now() }
        projectMap[body.projectName] = [automation]
        return json({ data: automation })
      }
      if (request.method() !== 'GET') return json({ ok: true, data: {} })
      return route.continue()
    })
    page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    await page.goto(base + '/#/')
    await page.locator('.new-thread-empty').waitFor()
    await page.getByRole('button', { name: 'Create Project', exact: true }).click()
    const dialog = page.locator('.app-dialog').filter({ has: page.locator('input[placeholder="Project name"]') })
    await dialog.waitFor()
    assert.equal(await dialog.getByPlaceholder('Target folder', { exact: true }).inputValue(), '')
    await dialog.getByPlaceholder('Project name', { exact: true }).fill('UI Organization')
    assert.equal(await dialog.locator('.project-directories-input').count(), 0)
    await dialog.getByPlaceholder('Project name', { exact: true }).press('Enter')
    await dialog.waitFor({ state: 'hidden' })
    const id = state.virtualProjects[0].id
    const group = page.locator(`.project-group[data-project-name="${id}"]`)
    await group.waitFor()
    assert.equal(await group.locator('.project-title').innerText(), 'UI Organization')
    assert.equal(await group.locator('.project-title').getAttribute('title'), 'UI Organization')
    await group.locator('.project-header-row').click()
    await group.locator('[data-organization-state="collapsed"]').waitFor()
    assert.equal(await group.locator('.project-empty-row:visible').count(), 0, 'collapsed empty organization must hide the empty row')
    await group.locator('.project-header-row').click()
    await group.locator('[data-organization-state="expanded"]').waitFor()
    await group.locator('.project-menu-trigger').click()
    await group.getByRole('button', { name: 'Edit project', exact: true }).click()
    await dialog.getByPlaceholder('Project name', { exact: true }).fill('UI Renamed')
    assert.equal(await dialog.getByPlaceholder('Target folder', { exact: true }).inputValue(), '')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.reload()
    await group.waitFor()
    assert.equal(await group.locator('.project-title').innerText(), 'UI Renamed')
    assert.deepEqual(state.order, ['/tmp/project-ui/real'])
    report.cases.push('name-only create, keyboard submit, abstract closed/open icons, rename and post-refresh persistence')

    const realGroup = page.locator('.project-group[data-project-name="real"]')
    async function checkCollapsed(project, empty) {
      if ((await project.getAttribute('data-expanded')) !== 'false') await project.locator('.project-header-row').click()
      assert.equal(await project.locator('.project-empty-row:visible, .thread-row:visible, .thread-show-more-row:visible').count(), 0)
      const header = await project.locator('.project-header-row').boundingBox()
      const bounds = await project.boundingBox()
      assert.ok(bounds.height <= header.height + 2, 'collapsed project must occupy only its header')
      await page.reload()
      await project.waitFor()
      assert.equal(await project.getAttribute('data-expanded'), 'false')
      assert.equal(await project.locator('.project-empty-row:visible, .thread-row:visible').count(), 0)
      await project.locator('.project-header-row').press('Enter')
      await project.locator(empty ? '.project-empty-row' : '.thread-row').waitFor()
      await project.locator('.project-header-row').press('Space')
      assert.equal(await project.locator('.project-empty-row:visible, .thread-row:visible').count(), 0)
    }
    for (const dark of [false, true]) {
      await checkCollapsed(group, true)
      await checkCollapsed(realGroup, true)
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await page.mouse.move(1000, 100)
      await page.waitForTimeout(2300)
      const filename = `output/playwright/0219-${label}empty-project-collapse-${dark ? 'dark' : 'light'}.png`
      await page.screenshot({ path: filename })
      report.screenshots.push(filename)
    }
    await group.locator('.project-header-row').click()
    report.cases.push('empty organization and directory project collapse to header only; mouse/Enter/Space and post-refresh state in both themes')

    // Move an existing native projectless conversation through the real menu/dialog.
    await page.locator('.thread-row-title:visible').filter({ hasText: 'Project UI conversation' }).first().hover()
    await page.locator('.thread-menu-trigger:visible').first().click()
    await page.getByRole('button', { name: 'Move to project', exact: true }).click()
    const moveDialog = page.getByRole('dialog', { name: 'Move to project', exact: true })
    await moveDialog.locator('.composer-dropdown-trigger').click()
    await page.getByRole('option', { name: 'UI Renamed', exact: true }).click()
    await moveDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.project-group[data-project-name^="virtual:"] .thread-row-title')?.textContent?.includes('Project UI conversation'))
    assert.deepEqual(state.virtualProjects[0].cwds, [projectCwd])
    assert.equal(nativeThread.cwd, projectCwd)
    await page.reload()
    await group.locator('.thread-row-title').waitFor()
    await checkCollapsed(group, false)
    await group.locator('.project-header-row').click()
    await group.locator('.thread-start-button').click()
    assert.ok((await page.locator('.new-thread-folder-dropdown').innerText()).includes('UI Renamed'))
    assert.equal(await page.locator('.content-header-terminal-command').count(), 0)
    report.cases.push('existing conversation moves under project and survives refresh; new-conversation action retains organization without a fake cwd')

    const auto = { id: 'ui-automation', kind: 'cron', name: 'Project schedule with a long title', prompt: 'Fixture only', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', status: 'PAUSED', cwds: [id], createdAtMs: Date.now(), updatedAtMs: Date.now(), timezone: 'Asia/Shanghai' }
    projectMap[id] = [auto]
    await page.goto(base + '/#/automations')
    await page.locator('.automation-row').waitFor()
    assert.equal(await page.locator('.automation-row-meta').innerText(), 'UI Renamed')
    for (const [width, height] of [[1440, 1000], [1100, 900], [900, 900], [768, 1024], [640, 900], [375, 812]]) {
      for (const dark of [false, true]) {
        await page.setViewportSize({ width, height })
        await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
        await page.waitForTimeout(2300)
        const bounds = await page.locator('.automations-panel').evaluate(element => {
          const rect = element.getBoundingClientRect()
          const parent = element.parentElement.getBoundingClientRect()
          return { left: rect.left - parent.left, right: parent.right - rect.right, panelWidth: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, background: getComputedStyle(element).backgroundColor }
        })
        assert.ok(bounds.left >= 11.5 && bounds.right >= 11.5, JSON.stringify({ width, bounds }))
        assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, JSON.stringify({ width, bounds }))
        report.boundaries.push({ width, height, dark, ...bounds })
        if ([1440, 768, 375].includes(width)) {
          const filename = `output/playwright/0219-${label}automations-margin-${width}-${dark ? 'dark' : 'light'}.png`
          await page.screenshot({ path: filename })
          report.screenshots.push(filename)
        }
      }
    }
    report.cases.push('automation target label and margins at 6 widths in both themes, including populated list and detail panel')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(base + '/#/')
    await group.waitFor()
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await page.waitForTimeout(2300)
      const filename = `output/playwright/0219-${label}project-organization-${dark ? 'dark' : 'light'}.png`
      await page.screenshot({ path: filename })
      report.screenshots.push(filename)
    }
    for (const language of ['en', 'zh-CN']) {
      await page.evaluate(value => localStorage.setItem('codex-web-local.ui-language.v1', value), language)
      await page.reload()
      await group.waitFor()
      await group.locator('.project-menu-trigger').click()
      await group.getByRole('button', { name: language === 'en' ? 'Edit project' : '编辑项目', exact: true }).click()
      const editor = page.locator('.app-dialog').filter({ has: page.locator('.new-thread-open-folder-create-input') })
      await editor.waitFor()
      for (const [width, height] of [[1440, 1000], [768, 1024], [375, 812]]) for (const dark of [false, true]) {
        await page.setViewportSize({ width, height })
        await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
        await page.mouse.move(width - 2, 2)
        await page.waitForTimeout(2300)
        const rect = await editor.boundingBox()
        assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width + 1 && rect.y >= 0 && rect.y + rect.height <= height + 1)
        assert.equal(await editor.locator('.new-thread-open-folder-path').inputValue(), '')
        assert.equal(await editor.locator('.project-directories-input').count(), 0)
        const filename = `output/playwright/0219-${label}project-editor-${language}-${width}-${dark ? 'dark' : 'light'}.png`
        await page.screenshot({ path: filename })
        report.screenshots.push(filename)
      }
      await editor.getByRole('button', { name: language === 'en' ? 'Cancel' : '取消', exact: true }).click()
      await page.setViewportSize({ width: 1440, height: 1000 })
    }
    await page.evaluate(() => localStorage.setItem('codex-web-local.ui-language.v1', 'en'))
    await page.reload()
    await group.waitFor()
    for (const expanded of [false, true]) {
      if ((await group.getAttribute('data-expanded')) !== String(expanded)) await group.locator('.project-header-row').click()
      await page.mouse.move(1000, 100)
      await page.waitForTimeout(2300)
      const filename = `output/playwright/0219-${label}project-icon-${expanded ? 'open' : 'closed'}.png`
      await group.screenshot({ path: filename })
      report.screenshots.push(filename)
    }
    report.cases.push('English/Chinese editor at desktop/tablet/mobile in both themes; dedicated closed/open organization icon evidence')
    await group.locator('.project-menu-trigger').click()
    await group.getByRole('button', { name: 'Remove', exact: true }).click()
    await group.waitFor({ state: 'hidden' })
    assert.equal(state.virtualProjects.length, 0)
    assert.ok(projectMap[id]?.some(row => row.id === auto.id))
    assert.ok(!report.requests.some(request => request.name === 'project-automation' && request.method === 'DELETE'))
    assert.equal(nativeThread.cwd, projectCwd)
    await page.reload()
    await page.getByText('Project UI conversation', { exact: true }).first().waitFor()
    assert.equal(await page.locator('.project-group[data-project-name^="virtual:"]').count(), 0)
    await page.goto(base + '/#/automations')
    await page.locator('.automation-row').waitFor()
    assert.equal(await page.locator('.automation-row-meta').innerText(), '—')
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      await page.waitForTimeout(2200)
      const filename = `output/playwright/0219-${label}removed-project-automation-${dark ? 'dark' : 'light'}.png`
      await page.screenshot({ path: filename })
      report.screenshots.push(filename)
    }
    assert.ok(!await page.locator('.automations-panel').innerText().then(text => text.includes('virtual:')))
    report.cases.push('removed organization retains automation with no internal ID in its label')
    report.cases.push('remove returns conversation to ungrouped list without deleting it')
    assert.ok(!report.requests.some(request => request.rpc === 'turn/start' || ['delivery', 'accounts/switch'].includes(request.name)))
    assert.deepEqual(report.errors, [])
    report.passed = true
  } finally {
    if (!report.passed && page) {
      await page.screenshot({ path: 'output/playwright/0219-project-ui-failure.png' }).catch(() => {})
      await fs.writeFile('output/0219-final/project-ui-failure.txt', await page.locator('body').innerText().catch(() => '')).catch(() => {})
    }
    await browser.close()
    await fs.mkdir('output/0219-final', { recursive: true })
    await fs.writeFile(process.env.UI_REPORT_PATH || 'output/0219-final/project-ui.json', JSON.stringify(report, null, 2))
  }
  console.log('PROJECT_ORGANIZATION_UI_PASS')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
