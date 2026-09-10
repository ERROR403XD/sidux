import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountActivationSession } from './accountActivationSession'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('independent activation conversation', () => {
  it('sends hi with fixed credentials, waits for completion, then removes only its private home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'activation-session-test-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'auth.json'), 'primary-auth-sentinel')
    await writeFile(join(root, 'accounts.json'), 'primary-selection-sentinel')
    const calls: Array<{ method: string; params: any }> = []
    let launchedHome = ''
    const spawnImpl = ((_: string, _args: string[], options: any) => {
      launchedHome = options.env.CODEX_HOME
      expect(launchedHome).not.toBe(root)
      expect(options.cwd).toBe(join(launchedHome, 'empty'))
      const script = `const rl=require('readline').createInterface({input:process.stdin});let reads=0;rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='account/read')result={account:{id:'fixed-account'}};if(m.method==='thread/start')result={thread:{id:'activation-thread'}};if(m.method==='turn/start')result={turn:{id:'activation-turn'}};if(m.method==='thread/read')result={thread:{turns:[{id:'activation-turn',status:++reads>2?'completed':reads===1?'interrupted':'inProgress',completedAt:null,error:null}]}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`
      const proc = spawn(process.execPath, ['-e', script], options)
      const write = proc.stdin.write.bind(proc.stdin)
      proc.stdin.write = ((value: string, ...rest: any[]) => { const call = JSON.parse(value); calls.push(call); return write(value, ...rest) }) as typeof proc.stdin.write
      return proc
    }) as typeof spawn
    const session = new AccountActivationSession(join(root, 'sessions'), { accessToken: 'fixture-only', accountId: 'fixed-account' }, { model: 'fixture-model', signal: new AbortController().signal, command: 'fixture', spawnImpl, pollMs: 5, cleanupDelayMs: 25 })
    cleanups.push(() => session.dispose())
    await session.prepare()
    const before = Date.now()
    await session.send(new AbortController().signal)
    expect(Date.now() - before).toBeGreaterThanOrEqual(25)
    expect(calls.find(call => call.method === 'account/login/start')?.params).toMatchObject({ type: 'chatgptAuthTokens', chatgptAccountId: 'fixed-account', accessToken: 'fixture-only' })
    expect(calls.find(call => call.method === 'turn/start')?.params.input).toEqual([{ type: 'text', text: 'hi', text_elements: [] }])
    expect(calls.filter(call => call.method === 'thread/read')).toHaveLength(3)
    expect(calls.some(call => /logout|rateLimitReset|switch/.test(call.method))).toBe(false)
    await session.dispose()
    expect(await readdir(join(root, 'sessions'))).toEqual([])
    expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('primary-auth-sentinel')
    expect(await readFile(join(root, 'accounts.json'), 'utf8')).toBe('primary-selection-sentinel')
  })
})
