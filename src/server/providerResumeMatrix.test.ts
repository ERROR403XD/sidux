import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AppServerProcess } from './codexAppServerBridge.js'
import { getAccountAuthCoordinator } from './accountAuthCoordinator.js'
import { getCustomConnectionStore } from './customConnectionStore.js'

it('resumes, forks and implicitly resumes across every configured outlet pair', async () => {
  const home = await mkdtemp(tmpdir() + '/provider-resume-matrix-')
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CODEXUI_CODEX_COMMAND', resolve('src/server/fixtures/account-app-server.cjs'))
  const coordinator = getAccountAuthCoordinator()
  const connections = getCustomConnectionStore()
  await connections.ready
  const app = new AppServerProcess()
  const credential = (id: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, refresh_token: 'fixture', access_token: 'header.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: id, user_id: id } })).toString('base64url') + '.signature' } })
  vi.spyOn(coordinator, 'refreshAccount').mockImplementation(async id => (await coordinator.store.readState()).accounts.find(account => account.storageId === id)!)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/models') ? { data: [{ id: 'external' }] } : { output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] }))))
  let legacy = false
  // Legacy outlets predate explicit account selection; emulate that stored state.
  vi.spyOn(connections, 'explicitSelection').mockImplementation(() => !legacy)
  const outlets: Array<{ name: string; provider: string; customId?: string; legacy?: string }> = [
    { name: 'a', provider: 'openai' }, { name: 'b', provider: 'openai' },
  ]
  try {
    for (const name of ['custom-a', 'custom-b']) {
      const draft = { alias: name, provider: 'custom', baseUrl: `https://${name}.test/v1`, apiKey: 'fixture', model: 'external', wireApi: 'responses' as const }
      await connections.save(draft, (await connections.test(draft)).token)
      const customId = connections.snapshot().connections.find(row => row.alias === name)!.storageId
      outlets.push({ name, provider: `custom_${customId}`, customId })
    }
    outlets.push({ name: 'zen', provider: 'opencode_zen', legacy: 'opencode-zen' }, { name: 'router', provider: 'openrouter_free', legacy: 'openrouter' }, { name: 'legacy-custom', provider: 'custom_endpoint', legacy: 'custom' })
    async function select(outlet: typeof outlets[number]) {
      legacy = !!outlet.legacy
      await connections.select(outlet.customId || null)
      await coordinator.store.upsertCredential(credential(outlet.name), { activate: true })
      await writeFile(home + '/webui-custom-providers.json', JSON.stringify({ enabled: legacy, provider: outlet.legacy, customKey: true, apiKey: 'fixture', customBaseUrl: 'https://legacy-custom.test/v1', model: 'external', wireApi: 'responses' }))
    }
    async function send(id: string) {
      await app.rpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'COMPLETE' }] })
      await vi.waitFor(async () => {
        const result = await app.rpc('thread/read', { threadId: id }) as any
        expect(result.thread.turns.at(-1).status).toBe('completed')
      })
    }
    for (const source of outlets) for (const target of outlets) {
      const label = `${source.name} -> ${target.name}`
      await select(source)
      const started = await app.rpc('thread/start', { cwd: home }) as any
      await send(started.thread.id)
      await select(target)
      const resumed = await app.rpc('thread/resume', { threadId: started.thread.id }) as any
      expect(resumed.thread.modelProvider, label + ' resume').toBe(target.provider)
      const forked = await app.rpc('thread/fork', { threadId: started.thread.id }) as any
      expect(forked.thread.modelProvider, label + ' fork').toBe(target.provider)
      expect(forked.thread.id).not.toBe(started.thread.id)
      await select(source)
      await app.rpc('thread/resume', { threadId: started.thread.id })
      await select(target)
      await send(started.thread.id)
      const continued = await app.rpc('thread/read', { threadId: started.thread.id }) as any
      expect(continued.thread.modelProvider, label + ' implicit resume').toBe(target.provider)
      expect(continued.thread.turns.at(-1).items.at(-1).text, label + ' identity').toBe('OUTPUT:' + (target.customId ? 'custom' : target.name))
    }
  } finally {
    const workers = [...(app as any).sessionWorkers.values()]
    app.stopTaskRouting()
    app.dispose()
    await Promise.all([app, ...workers].map(worker => (worker as any).closingSession))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
