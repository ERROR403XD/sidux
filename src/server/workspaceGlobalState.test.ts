import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCodexBridgeMiddleware } from './codexAppServerBridge'
import { writeImportedThreadTitle } from './routes/preferencesRoutes'

it('creates a project then saves workspace and preference state through the real bridge transaction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'workspace-global-state-'))
  const statePath = join(home, '.codex-global-state.json')
  await writeFile(statePath, JSON.stringify({ unrelated: 'keep', 'thread-queue-state': {} }))
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const bridge = createCodexBridgeMiddleware()
  const server = createServer((req, res) => {
    void bridge(req, res, () => { res.statusCode = 404; res.end() })
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/codex-api`
    const request = async (route: string, method: string, body: unknown) => {
      const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2000),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const project = join(home, 'created-project')
    await request('/project-root', 'POST', { path: project, createIfMissing: true, label: 'Regression project' })
    await request('/workspace-roots-state', 'PUT', {
      order: [project], labels: { [project]: 'Saved project' }, active: [project], projectOrder: [project],
    })
    await Promise.all([
      request('/thread-titles', 'PUT', { id: 'thread', title: 'Saved title' }),
      request('/thread-pins', 'PUT', { threadIds: ['thread'] }),
      request('/preferences/first-launch-plugins-card', 'PUT', { dismissed: true }),
      writeImportedThreadTitle('imported', 'Imported title'),
    ])
    const queueResponse = await fetch(base + '/thread-queue-state')
    expect(queueResponse.status).toBe(200)
    expect((await queueResponse.json()).data).toEqual({})
    const persisted = JSON.parse(await readFile(statePath, 'utf8'))
    expect(persisted).toMatchObject({
      unrelated: 'keep',
      'electron-saved-workspace-roots': [project],
      'thread-titles': { titles: { thread: 'Saved title', imported: 'Imported title' } },
      'pinned-thread-ids': ['thread'],
      'first-launch-plugins-card-dismissed': true,
    })
    expect(persisted).not.toHaveProperty('thread-queue-state')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await bridge.dispose()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})
