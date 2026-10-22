import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectScope, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody, setJson } from '../server/httpUtils'
import { createThreadFileRollbackService } from '../server/threadFileRollbackService'
import { createThreadFileRollbackRoutes } from '../server/routes/threadFileRollbackRoutes'
import { ThreadHistory } from '../server/threadHistory'
import { createConversationFileActionsController } from './conversationFileActionsController'

let directory: string
let server: Server
let scope: EffectScope
let actions: ReturnType<typeof createConversationFileActionsController>
let requests: Record<string, unknown>[]
let rpcError: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sidux-conversation-file-http-'))
  const sessionPath = join(directory, 'fixture.jsonl')
  await writeFile(sessionPath, ['a', 'b'].flatMap(id => [
    { type: 'turn_context', payload: { turn_id: 'turn-a' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', status: 'completed', call_id: `patch-${id}`, input: `*** Begin Patch\n*** Update File: ${id}.txt\n@@\n-${id}0\n+${id}1\n*** End Patch` } },
  ]).map(row => JSON.stringify(row)).join('\n'))
  await writeFile(join(directory, 'a.txt'), 'a1\n')
  await writeFile(join(directory, 'b.txt'), 'b1\n')
  await writeFile(join(directory, 'later.txt'), 'preserve\n')
  rpcError = ''
  const rpc = async () => {
    if (rpcError) throw new Error(rpcError)
    return { thread: { id: 'thread-a', path: sessionPath, historyMode: 'legacy', status: { type: 'idle' }, turns: [{ id: 'turn-a' }, { id: 'turn-b' }] } }
  }
  const history = new ThreadHistory(rpc, async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }))
  const route = createThreadFileRollbackRoutes(createThreadFileRollbackService({ history, rpc }))
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unknown route' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  const realFetch = globalThis.fetch
  requests = []
  vi.stubGlobal('fetch', (input: string, init: RequestInit) => {
    expect(input).toBe('/codex-api/thread/rollback-files')
    requests.push(JSON.parse(init.body as string))
    return realFetch(`http://127.0.0.1:${address.port}${input}`, init)
  })
  scope = effectScope()
  actions = scope.run(() => createConversationFileActionsController({ getThreadId: () => 'thread-a', getCwd: () => directory, getAccountRevision: () => 0 }))!
})

afterEach(async () => {
  actions.stop()
  scope.stop()
  vi.unstubAllGlobals()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(directory, { recursive: true, force: true })
})

describe('Conversation controller / real gateway / HTTP / filesystem integration', () => {
  it('retries only the failed patch after partial redo, then undoes both restored patches', async () => {
    const target = { turnId: 'turn-a' }
    await actions.runFileChangeAction(target, 'undo')
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('a0\n')
    expect(await readFile(join(directory, 'b.txt'), 'utf8')).toBe('b0\n')
    await writeFile(join(directory, 'b.txt'), 'local edit\n')
    await actions.runFileChangeAction(target, 'redo')
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('a1\n')
    expect(await readFile(join(directory, 'b.txt'), 'utf8')).toBe('local edit\n')
    expect(actions.fileChangeNextAction(target)).toBe('redo')
    expect(actions.fileChangeActionErrorText(target)).toContain('Could not apply patch')
    await writeFile(join(directory, 'b.txt'), 'b0\n')
    await actions.runFileChangeAction(target, 'redo')
    expect(requests.at(-1)?.patchIds).toEqual(['patch-b'])
    expect(await readFile(join(directory, 'b.txt'), 'utf8')).toBe('b1\n')
    expect(actions.fileChangeNextAction(target)).toBe('undo')
    await actions.runFileChangeAction(target, 'undo')
    expect(new Set(requests.at(-1)?.patchIds as string[])).toEqual(new Set(['patch-a', 'patch-b']))
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('a0\n')
    expect(await readFile(join(directory, 'b.txt'), 'utf8')).toBe('b0\n')
    expect(await readFile(join(directory, 'later.txt'), 'utf8')).toBe('preserve\n')
    expect(requests).toHaveLength(4)
    expect(requests.every(body => body.scope === 'single_turn' && body.threadId === 'thread-a' && body.cwd === directory)).toBe(true)
  })

  it('preserves Undo and file content across an HTTP 500 before retry', async () => {
    const target = { turnId: 'turn-a' }
    rpcError = 'fixture HTTP failure'
    await actions.runFileChangeAction(target, 'undo')
    expect(actions.fileChangeNextAction(target)).toBe('undo')
    expect(actions.fileChangeActionErrorText(target)).toBe('fixture HTTP failure')
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('a1\n')
    rpcError = ''
    await actions.runFileChangeAction(target, 'undo')
    expect(actions.fileChangeNextAction(target)).toBe('redo')
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('a0\n')
    expect(requests).toHaveLength(2)
  })
})
