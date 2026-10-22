import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { createThreadFileRollbackService } from '../threadFileRollbackService.js'
import { ThreadHistory } from '../threadHistory.js'
import { createThreadFileRollbackRoutes } from './threadFileRollbackRoutes.js'

const execFileAsync = promisify(execFile)
let fixture: string
let cwd: string
let sessionPath: string
let server: Server
let baseUrl: string
let historyMode: string
let status: { type: string }
let rpc: ReturnType<typeof vi.fn<(method: string, params: any) => Promise<unknown>>>

async function git(args: string[]) {
  return (await execFileAsync('git', args, { cwd })).stdout.trim()
}

async function session(patches: Array<{ turn: string; id: string; input: string }>) {
  const rows = patches.flatMap(patch => [
    { type: 'turn_context', payload: { turn_id: patch.turn } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', status: 'completed', call_id: patch.id, input: patch.input } },
  ])
  await writeFile(sessionPath, rows.map(row => JSON.stringify(row)).join('\n'))
}

async function rollback(body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/codex-api/thread/rollback-files`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: 'thread-a', turnId: 'turn-a', cwd, ...body }),
  })
  return { status: response.status, body: await response.json() as any }
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'sidux-file-rollback-'))
  cwd = join(fixture, 'repo')
  await mkdir(cwd)
  sessionPath = join(fixture, 'fixture.jsonl')
  await writeFile(sessionPath, '')
  await git(['init', '--initial-branch=main'])
  await writeFile(join(cwd, 'original.txt'), 'initial\n')
  await git(['add', 'original.txt'])
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'])
  historyMode = 'legacy'
  status = { type: 'idle' }
  rpc = vi.fn(async (method, params) => {
    if (method !== 'thread/read') throw new Error('Unexpected fixture RPC')
    return { thread: { id: params.threadId, path: sessionPath, historyMode, status, turns: [{ id: 'turn-a' }, { id: 'turn-b' }] } }
  })
  const history = new ThreadHistory(rpc, async () => ({ historyPaging: true, resumeInitialPage: true, exactFork: true }))
  const route = createThreadFileRollbackRoutes(createThreadFileRollbackService({ history, rpc }))
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unknown route' })
    }).catch(error => setJson(res, 502, { error: error.message }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(fixture, { recursive: true, force: true })
})

describe('file rollback HTTP/history/temporary Git integration', () => {
  it.each(['paginated', 'active'])('rejects %s history before a full read or file mutation', async mode => {
    if (mode === 'paginated') historyMode = mode
    else status = { type: mode }
    await writeFile(join(cwd, 'added.txt'), 'preserve')
    await session([{ turn: 'turn-a', id: 'patch-a', input: '*** Begin Patch\n*** Add File: added.txt\n+preserve\n*** End Patch' }])
    const response = await rollback()
    expect(response.status).toBe(500)
    expect(response.body.error).toContain(mode === 'paginated' ? '不支持撤回' : '等待当前回合')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 'thread-a', includeTurns: false })
    expect(await readFile(join(cwd, 'added.txt'), 'utf8')).toBe('preserve')
  })

  it('limits a single-turn operation to selected patch IDs without touching later turns', async () => {
    await writeFile(join(cwd, 'a.txt'), 'a\n')
    await writeFile(join(cwd, 'b.txt'), 'b\n')
    await writeFile(join(cwd, 'later.txt'), 'later\n')
    await session([
      { turn: 'turn-a', id: 'patch-a', input: '*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch' },
      { turn: 'turn-a', id: 'patch-b', input: '*** Begin Patch\n*** Add File: b.txt\n+b\n*** End Patch' },
      { turn: 'turn-b', id: 'patch-later', input: '*** Begin Patch\n*** Add File: later.txt\n+later\n*** End Patch' },
    ])
    expect(await rollback({ scope: 'single_turn', patchIds: ['patch-a', '', 7] })).toEqual({ status: 200, body: {
      reverted: 1, errors: [], revertedPatchIds: ['patch-a'], changed: 1, message: 'Reverted 1 file change(s)',
    } })
    await expect(readFile(join(cwd, 'a.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('b\n')
    expect(await readFile(join(cwd, 'later.txt'), 'utf8')).toBe('later\n')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('thread/read', { threadId: 'thread-a', includeTurns: true })
  })

  it('undoes multiple turns in reverse order and redoes them in original order', async () => {
    await session([
      { turn: 'turn-a', id: 'patch-a', input: '*** Begin Patch\n*** Update File: original.txt\n@@ -1 +1 @@\n-initial\n+one\n*** End Patch' },
      { turn: 'turn-b', id: 'patch-b', input: '*** Begin Patch\n*** Update File: original.txt\n@@ -1 +1 @@\n-one\n+two\n*** End Patch' },
    ])
    await writeFile(join(cwd, 'original.txt'), 'two\n')
    const undo = await rollback()
    expect(undo).toEqual({ status: 200, body: { reverted: 2, errors: [], revertedPatchIds: ['patch-b', 'patch-a'], changed: 2, message: 'Reverted 2 file change(s)' } })
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('initial\n')
    expect(rpc.mock.calls).toEqual([
      ['thread/read', { threadId: 'thread-a', includeTurns: false }],
      ['thread/read', { threadId: 'thread-a', includeTurns: true }],
    ])
    const redo = await rollback({ action: 'redo' })
    expect(redo).toEqual({ status: 200, body: { applied: 2, errors: [], appliedPatchIds: ['patch-a', 'patch-b'], changed: 2, message: 'Reapplied 2 file change(s)' } })
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('two\n')
  })

  it('undoes and redoes moves with content changes', async () => {
    await session([{ turn: 'turn-a', id: 'move', input: '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@ -1 +1 @@\n-before\n+after\n*** End Patch' }])
    await writeFile(join(cwd, 'new.txt'), 'after\n')
    expect((await rollback({ scope: 'single_turn' })).body.revertedPatchIds).toEqual(['move'])
    expect(await readFile(join(cwd, 'old.txt'), 'utf8')).toBe('before\n')
    await expect(readFile(join(cwd, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await rollback({ scope: 'single_turn', action: 'redo' })).body.appliedPatchIds).toEqual(['move'])
    expect(await readFile(join(cwd, 'new.txt'), 'utf8')).toBe('after\n')
    await expect(readFile(join(cwd, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores a deleted tracked file through exact Git path fallback', async () => {
    await session([{ turn: 'turn-a', id: 'delete', input: '*** Begin Patch\n*** Delete File: original.txt\n*** End Patch' }])
    await rm(join(cwd, 'original.txt'))
    expect((await rollback({ scope: 'single_turn' })).body).toMatchObject({ changed: 1, errors: [], revertedPatchIds: ['delete'] })
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('initial\n')
    expect((await rollback({ scope: 'single_turn', action: 'redo' })).body).toMatchObject({ changed: 1, errors: [], appliedPatchIds: ['delete'] })
    await expect(readFile(join(cwd, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports patch failure without destroying an untracked file', async () => {
    await session([{ turn: 'turn-a', id: 'mismatch', input: '*** Begin Patch\n*** Update File: untracked.txt\n@@\n-original\n+changed\n*** End Patch' }])
    await writeFile(join(cwd, 'untracked.txt'), 'unrelated local content\n')
    const result = await rollback({ scope: 'single_turn' })
    expect(result.status).toBe(200)
    expect(result.body.changed).toBe(0)
    expect(result.body.errors).toEqual([`Could not reverse patch for untracked file: ${join(cwd, 'untracked.txt')}`])
    expect(await readFile(join(cwd, 'untracked.txt'), 'utf8')).toBe('unrelated local content\n')
  })

  it.each(['undo', 'redo'])('keeps one multi-file patch retryable after a partial %s failure', async action => {
    const input = '*** Begin Patch\n*** Update File: b.txt\n@@\n-b0\n+b1\n*** Update File: a.txt\n@@\n-a0\n+a1\n*** End Patch'
    await session([{ turn: 'turn-a', id: 'multi-file', input }])
    // Undo processes changes in reverse; redo processes them in forward order.
    const valid = action === 'undo' ? 'a' : 'b'
    const invalid = action === 'undo' ? 'b' : 'a'
    const initial = action === 'undo' ? '1' : '0'
    const target = action === 'undo' ? '0' : '1'
    await writeFile(join(cwd, `${valid}.txt`), `${valid}${initial}\n`)
    await writeFile(join(cwd, `${invalid}.txt`), 'local edit\n')
    const failed = await rollback({ scope: 'single_turn', action })
    expect(failed.status).toBe(200)
    expect(failed.body.changed).toBe(0)
    expect(failed.body.errors).toHaveLength(1)
    expect(failed.body[action === 'undo' ? 'revertedPatchIds' : 'appliedPatchIds']).toEqual([])
    expect(await readFile(join(cwd, `${valid}.txt`), 'utf8')).toBe(`${valid}${initial}\n`)
    expect(await readFile(join(cwd, `${invalid}.txt`), 'utf8')).toBe('local edit\n')
    await writeFile(join(cwd, `${invalid}.txt`), `${invalid}${initial}\n`)
    const retried = await rollback({ scope: 'single_turn', action })
    expect(retried.body).toMatchObject({ changed: 2, errors: [] })
    expect(retried.body[action === 'undo' ? 'revertedPatchIds' : 'appliedPatchIds']).toEqual(['multi-file'])
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe(`a${target}\n`)
    expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe(`b${target}\n`)
  })

  it('retains successful independent patches and retries only the failed subset', async () => {
    const input = (name: string) => `*** Begin Patch\n*** Update File: ${name}.txt\n@@\n-${name}0\n+${name}1\n*** End Patch`
    await session([{ turn: 'turn-a', id: 'a', input: input('a') }, { turn: 'turn-a', id: 'b', input: input('b') }])
    await writeFile(join(cwd, 'a.txt'), 'a1\n')
    await writeFile(join(cwd, 'b.txt'), 'local edit\n')
    const undo = await rollback({ scope: 'single_turn' })
    expect(undo.body).toMatchObject({ changed: 1, revertedPatchIds: ['a'] })
    expect(undo.body.errors).toHaveLength(1)
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('a0\n')
    expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('local edit\n')
    await writeFile(join(cwd, 'b.txt'), 'b1\n')
    expect((await rollback({ scope: 'single_turn', patchIds: ['b'] })).body).toMatchObject({ changed: 1, errors: [], revertedPatchIds: ['b'] })
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('a0\n')
    expect((await rollback({ scope: 'single_turn', action: 'redo', patchIds: ['a', 'b'] })).body).toMatchObject({ changed: 2, errors: [], appliedPatchIds: ['a', 'b'] })
  })

  it('restores binary bytes, modes, links, moves and newly created directories after a mixed patch fails', async () => {
    const binary = Buffer.from([0, 255, 13, 10, 32])
    await writeFile(join(cwd, 'original.txt'), binary)
    await chmod(join(cwd, 'original.txt'), 0o755)
    await writeFile(join(cwd, 'old.txt'), 'before\n')
    await writeFile(join(cwd, 'target.txt'), 'link-before\n')
    await symlink('target.txt', join(cwd, 'link.txt'))
    await writeFile(join(cwd, 'invalid.txt'), 'local edit\n')
    await session([{ turn: 'turn-a', id: 'mixed', input: [
      '*** Begin Patch', '*** Add File: nested/deep/added.txt', '+added',
      '*** Delete File: original.txt', '*** Update File: old.txt', '*** Move to: new.txt', '@@', '-before', '+after',
      '*** Update File: link.txt', '@@', '-link-before', '+link-after',
      '*** Update File: invalid.txt', '@@', '-before', '+after', '*** End Patch',
    ].join('\n') }])
    const failed = await rollback({ scope: 'single_turn', action: 'redo' })
    expect(failed.body).toMatchObject({ changed: 0, appliedPatchIds: [] })
    expect(failed.body.errors).toHaveLength(1)
    expect(await readFile(join(cwd, 'original.txt'))).toEqual(binary)
    expect((await stat(join(cwd, 'original.txt'))).mode & 0o777).toBe(0o755)
    expect(await readFile(join(cwd, 'old.txt'), 'utf8')).toBe('before\n')
    await expect(stat(join(cwd, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(cwd, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readlink(join(cwd, 'link.txt'))).toBe('target.txt')
    expect(await readFile(join(cwd, 'target.txt'), 'utf8')).toBe('link-before\n')
    expect(await readFile(join(cwd, 'invalid.txt'), 'utf8')).toBe('local edit\n')
  })

  it('restores a tracked binary executable without changing the staged index', async () => {
    const binary = Buffer.from([0, 255, 13, 10, 32])
    await writeFile(join(cwd, 'binary.bin'), binary)
    await chmod(join(cwd, 'binary.bin'), 0o755)
    await git(['add', 'binary.bin'])
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'binary'])
    await writeFile(join(cwd, 'binary.bin'), Buffer.from([1, 128, 2]))
    await git(['add', 'binary.bin'])
    const staged = await git(['rev-parse', ':binary.bin'])
    await rm(join(cwd, 'binary.bin'))
    await session([{ turn: 'turn-a', id: 'delete-binary', input: '*** Begin Patch\n*** Delete File: binary.bin\n*** End Patch' }])
    expect((await rollback({ scope: 'single_turn' })).body).toMatchObject({ changed: 1, errors: [], revertedPatchIds: ['delete-binary'] })
    expect(await readFile(join(cwd, 'binary.bin'))).toEqual(binary)
    expect((await stat(join(cwd, 'binary.bin'))).mode & 0o777).toBe(0o755)
    expect(await git(['rev-parse', ':binary.bin'])).toBe(staged)
  })

  it('keeps command fallback outside an explicitly selected patch subset', async () => {
    await writeFile(join(cwd, 'a.txt'), 'after\n')
    await writeFile(join(cwd, 'original.txt'), 'local command change\n')
    await session([{ turn: 'turn-a', id: 'selected', input: '*** Begin Patch\n*** Update File: a.txt\n@@\n-before\n+after\n*** End Patch' }])
    const raw = await readFile(sessionPath, 'utf8')
    await writeFile(sessionPath, raw + '\n' + JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo changed > original.txt' }),
    } }))
    expect((await rollback({ scope: 'single_turn', patchIds: ['selected'] })).body).toMatchObject({ changed: 1, errors: [], revertedPatchIds: ['selected'] })
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('before\n')
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('local command change\n')
  })

  it('serializes same-workspace HTTP operations and releases the slot after a failure', async () => {
    await writeFile(join(cwd, 'a.txt'), 'before\n')
    await session([{ turn: 'turn-a', id: 'selected', input: '*** Begin Patch\n*** Update File: a.txt\n@@\n-before\n+after\n*** End Patch' }])
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(done => { release = done })
    const started = new Promise<void>(done => { entered = done })
    rpc.mockImplementationOnce(async () => {
      entered()
      await waiting
      throw new Error('first read failed')
    })
    const first = rollback({ scope: 'single_turn', action: 'redo' })
    await started
    const second = rollback({ scope: 'single_turn', action: 'redo' })
    await new Promise(done => setTimeout(done, 40))
    expect(rpc).toHaveBeenCalledTimes(1)
    release()
    expect((await first).status).toBe(500)
    expect((await second).body).toMatchObject({ changed: 1, errors: [], appliedPatchIds: ['selected'] })
    expect((await rollback({ scope: 'single_turn' })).body).toMatchObject({ changed: 1, errors: [], revertedPatchIds: ['selected'] })
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('before\n')
  })

  it('reapplies a bare hunk and reports mismatched input without claiming success', async () => {
    await session([{ turn: 'turn-a', id: 'bare-hunk', input: '*** Begin Patch\n*** Update File: original.txt\n@@\n-initial\n+changed\n*** End Patch' }])
    const result = await rollback({ scope: 'single_turn', action: 'redo' })
    expect(result.body).toMatchObject({ applied: 1, errors: [], appliedPatchIds: ['bare-hunk'] })
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('changed\n')
    await writeFile(join(cwd, 'original.txt'), 'local edit\n')
    const mismatch = await rollback({ scope: 'single_turn', action: 'redo' })
    expect(mismatch.body).toMatchObject({ applied: 0, appliedPatchIds: [] })
    expect(mismatch.body.errors).toEqual([`Could not apply patch for ${join(cwd, 'original.txt')}`])
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('local edit\n')
  })

  it.each(['@@\n', ''])('reapplies unnumbered hunks (%j) including end-of-file markers', async header => {
    await session([{ turn: 'turn-a', id: 'unnumbered', input: `*** Begin Patch\n*** Update File: original.txt\n${header}-initial\n+changed\n*** End of File\n*** End Patch` }])
    expect((await rollback({ scope: 'single_turn', action: 'redo' })).body).toMatchObject({ changed: 1, errors: [] })
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('changed\n')
  })

  it('matches contextual hunks in order when earlier text repeats', async () => {
    await writeFile(join(cwd, 'original.txt'), 'same\nfirst\nsame\nsecond\nsame\n')
    await session([{ turn: 'turn-a', id: 'context', input: '*** Begin Patch\n*** Update File: original.txt\n@@ first\n-same\n+one\n@@ second\n-same\n+two\n*** End Patch' }])
    expect((await rollback({ scope: 'single_turn', action: 'redo' })).body).toMatchObject({ changed: 1, errors: [] })
    expect(await readFile(join(cwd, 'original.txt'), 'utf8')).toBe('same\nfirst\none\nsecond\ntwo\n')
  })

  it('reapplies bare hunks across turns and moves with changed contents', async () => {
    await session([
      { turn: 'turn-a', id: 'first', input: '*** Begin Patch\n*** Update File: original.txt\n@@\n-initial\n+one\n*** End Patch' },
      { turn: 'turn-b', id: 'move', input: '*** Begin Patch\n*** Update File: original.txt\n*** Move to: new.txt\n@@\n-one\n+two\n*** End Patch' },
    ])
    expect((await rollback({ action: 'redo' })).body).toMatchObject({ changed: 2, errors: [], appliedPatchIds: ['first', 'move'] })
    expect(await readFile(join(cwd, 'new.txt'), 'utf8')).toBe('two\n')
    await expect(readFile(join(cwd, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps validation, missing-turn, empty-log and unreadable-log response shapes', async () => {
    expect(await rollback({ threadId: '' })).toEqual({ status: 400, body: { error: 'Missing threadId, turnId, or cwd' } })
    expect(rpc).not.toHaveBeenCalled()
    expect(await rollback({ turnId: 'missing', scope: 'single_turn' })).toEqual({ status: 200, body: { reverted: 0, errors: [], message: 'No turns to revert' } })
    expect(await rollback({ scope: 'single_turn' })).toEqual({ status: 200, body: { changed: 0, errors: [], message: 'No file changes to revert' } })
    await rm(sessionPath)
    expect(await rollback({ scope: 'single_turn' })).toEqual({ status: 200, body: { reverted: 0, errors: ['Could not read session log'], message: 'Session log unreadable' } })
  })
})
