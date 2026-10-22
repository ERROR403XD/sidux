import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('pages strictly before the resume cursor without gaps, duplicates or a missing partial page', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sidux-baseline-cursor-'))
  const directory = join(home, 'sessions/2026/10')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 't.json'), JSON.stringify({ id: 't', updatedAt: 1, createdAt: 1, turns: Array.from({ length: 80 }, (_, id) => ({ id: String(id), items: [] })) }))
  const child = spawn(process.execPath, [process.env.BASELINE_APP_SERVER_SOURCE || fileURLToPath(new URL('./022-baseline-app-server.cjs', import.meta.url)), 'app-server'], { env: { CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const lines = createInterface({ input: child.stdout })
  let sequence = 0
  const readers = new Map<number, (result: any) => void>()
  lines.on('line', line => {
    const response = JSON.parse(line)
    readers.get(response.id)?.(response)
    readers.delete(response.id)
  })
  const call = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const id = ++sequence
    readers.set(id, response => response.error ? reject(new Error(response.error.message)) : resolve(response.result))
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    await call('thread/list', {})
    const resumed = await call('thread/resume', { threadId: 't' })
    expect(resumed.initialTurnsPage.data.map((turn: any) => turn.id)).toEqual(Array.from({ length: 10 }, (_, i) => String(79 - i)))
    let cursor = resumed.initialTurnsPage.nextCursor
    const ids = resumed.initialTurnsPage.data.map((turn: any) => turn.id)
    while (cursor) {
      const page = await call('thread/turns/list', { threadId: 't', cursor, limit: 20 })
      expect(page.nextCursor).not.toBe(cursor)
      ids.push(...page.data.map((turn: any) => turn.id))
      cursor = page.nextCursor
    }
    expect(ids).toEqual(Array.from({ length: 80 }, (_, i) => String(79 - i)))
  } finally {
    lines.close()
    if (child.exitCode === null) child.kill('SIGTERM')
    await exited
    await rm(home, { recursive: true, force: true })
  }
}, 10000)
