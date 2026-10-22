import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as commands from './commandExecution.js'
import { createGitWorkspaceService } from './gitWorkspaceService.js'
import { queueGlobalStateMutation, readGlobalState, writeGlobalState } from './globalStateStore.js'
import { readAnyJsonBody, setJson } from './httpUtils.js'
import { createGitRoutes } from './routes/gitRoutes.js'

const execFileAsync = promisify(execFile)
let fixture: string
let repo: string
let home: string
let statePath: string
let server: Server
let baseUrl: string
let service: ReturnType<typeof createGitWorkspaceService>
let persist: ReturnType<typeof vi.fn<(cwd: string) => Promise<void>>>

async function git(args: string[], cwd = repo): Promise<string> {
  const result = await execFileAsync('git', args, { cwd })
  return result.stdout.trim()
}

async function commit(subject: string): Promise<string> {
  await git(['add', '--all'])
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', subject])
  return git(['rev-parse', 'HEAD'])
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/codex-api/${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { data: any; error?: string } }
}

async function get(path: string, params: Record<string, string>) {
  return request(`${path}?${new URLSearchParams(params)}`)
}

async function backupContent(path: string) {
  const backupRoot = join(repo, '.codex', 'untracked-backups')
  const directories = await readdir(backupRoot)
  return Promise.all(directories.map(directory => readFile(join(backupRoot, directory, path), 'utf8')))
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'sidux-git-service-'))
  repo = join(fixture, 'repo')
  home = join(fixture, 'home')
  statePath = join(home, '.codex-global-state.json')
  await mkdir(repo)
  await mkdir(home)
  await git(['init', '--initial-branch=main'])
  await writeFile(join(repo, 'tracked.txt'), 'initial\n')
  await commit('initial')
  await writeGlobalState(statePath, { unrelated: 'keep', order: [] })
  persist = vi.fn(async (cwd: string) => {
    await queueGlobalStateMutation(statePath, async () => {
      const state = await readGlobalState(statePath)
      await writeGlobalState(statePath, { ...state, order: [cwd, ...(state.order as string[])] })
    })
  })
  service = createGitWorkspaceService({ getCodexHomeDir: () => home, persistWorkspaceRoot: persist })
  const route = createGitRoutes(service)
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unknown route' })
    }).catch(error => setJson(res, 500, { error: error.message }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(fixture, { recursive: true, force: true })
})

describe('Git workspace HTTP/service/filesystem integration', () => {
  it('creates detached and permanent worktrees, persists once, and keeps separate homes', async () => {
    await git(['branch', 'feature'])
    const created = await request('worktree/create', { sourceCwd: ` ${repo} `, baseBranch: 'feature' })
    expect(created.status).toBe(200)
    const cwd = created.body.data.cwd
    expect(dirname(dirname(cwd))).toBe(join(home, 'worktrees'))
    expect(basename(dirname(cwd))).toMatch(/^[a-f0-9]{4}$/)
    expect(created.body.data).toEqual({ cwd, branch: null, gitRoot: repo })
    expect(await git(['branch', '--show-current'], cwd)).toBe('')
    expect(await readFile(join(cwd, 'tracked.txt'), 'utf8')).toBe('initial\n')
    expect(persist).toHaveBeenCalledTimes(1)
    expect(await readGlobalState(statePath)).toEqual({ unrelated: 'keep', order: [cwd] })

    const permanent = await request('worktree/create-permanent', { sourceCwd: repo, worktreeName: 'My Worktree' })
    expect(permanent).toEqual({ status: 200, body: { data: { cwd: join(fixture, 'My Worktree'), branch: 'My-Worktree', gitRoot: repo } } })
    expect(await git(['branch', '--show-current'], permanent.body.data.cwd)).toBe('My-Worktree')
    expect(persist).toHaveBeenCalledTimes(2)
    expect((await readGlobalState(statePath)).order).toEqual([permanent.body.data.cwd, cwd])

    const otherHome = join(fixture, 'other-home')
    const other = createGitWorkspaceService({ getCodexHomeDir: () => otherHome, persistWorkspaceRoot: async () => {} })
    const separate = await other.createWorktree(repo, '')
    expect(separate.cwd.startsWith(`${otherHome}/worktrees/`)).toBe(true)
    expect((await readGlobalState(statePath)).order).toEqual([permanent.body.data.cwd, cwd])
  })

  it.each(['detached', 'permanent'])('rolls back %s worktree and its branch after persistence fails', async mode => {
    persist.mockRejectedValueOnce(new Error('fixture write failure'))
    const result = await request(mode === 'detached' ? 'worktree/create' : 'worktree/create-permanent', {
      sourceCwd: repo, worktreeName: 'rollback',
    })
    expect(result).toEqual({ status: 500, body: { error: 'fixture write failure' } })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(await git(['worktree', 'list', '--porcelain'])).not.toContain('/rollback')
    expect((await git(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1)
    expect(await git(['branch', '--list', 'rollback'])).toBe('')
    if (mode === 'detached') expect(await readdir(join(home, 'worktrees'))).toEqual([])
    else await expect(readFile(join(fixture, 'rollback', 'tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readGlobalState(statePath)).toEqual({ unrelated: 'keep', order: [] })
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('initial\n')
  })

  it.each(['detached', 'permanent'])('initializes an empty source for %s worktree without adding unrelated files', async mode => {
    const empty = join(fixture, 'empty')
    await mkdir(empty)
    await writeFile(join(empty, 'personal.txt'), 'preserve')
    const result = await request(mode === 'detached' ? 'worktree/create' : 'worktree/create-permanent', {
      sourceCwd: empty, worktreeName: 'from-empty',
    })
    expect(result.status).toBe(200)
    expect(await git(['ls-files'], empty)).toBe('AGENTS.md')
    expect(await readFile(join(empty, 'personal.txt'), 'utf8')).toBe('preserve')
    expect(await readFile(join(result.body.data.cwd, 'AGENTS.md'), 'utf8')).toBe('')
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('returns validation/conflict contracts and leaves existing folders untouched', async () => {
    expect(await request('worktree/create', null)).toEqual({ status: 400, body: { error: 'Missing sourceCwd' } })
    expect(await request('git/checkout', [])).toEqual({ status: 400, body: { error: 'Invalid body: expected object' } })
    expect(await request('git/reset-to-commit', { cwd: repo, branch: 'main' })).toEqual({ status: 400, body: { error: 'Missing commit' } })
    expect(await request('worktree/create-permanent', { sourceCwd: repo, worktreeName: '../unsafe' })).toEqual({ status: 400, body: { error: 'Worktree name must be a single folder name' } })
    await mkdir(join(fixture, 'existing'))
    await writeFile(join(fixture, 'existing', 'keep'), 'preserve')
    expect(await request('worktree/create-permanent', { sourceCwd: repo, worktreeName: 'existing' })).toEqual({ status: 409, body: { error: 'Worktree folder already exists' } })
    expect(await readFile(join(fixture, 'existing', 'keep'), 'utf8')).toBe('preserve')
    for (const path of ['worktree/create', 'worktree/create-permanent', 'git/checkout']) {
      const field = path.startsWith('worktree') ? 'sourceCwd' : 'cwd'
      const result = await request(path, { [field]: join(repo, 'tracked.txt'), branch: 'main', worktreeName: 'invalid' })
      expect(result).toEqual({ status: 400, body: { error: `${field} is not a directory` } })
    }
    expect(await get('worktree/branches', { sourceCwd: join(repo, 'missing') })).toEqual({ status: 404, body: { error: 'sourceCwd does not exist' } })
    expect(persist).not.toHaveBeenCalled()
  })

  it('keeps branch activity, remote flags, detached state, and non-repository responses', async () => {
    await git(['branch', 'feature'])
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const header = await get('git/branches', { cwd: repo })
    expect(header.status).toBe(200)
    expect(header.body.data).toMatchObject({ currentBranch: 'main', detached: false, dirty: false, gitRoot: repo })
    expect(header.body.data.options).toEqual(expect.arrayContaining([
      { value: 'main', label: 'main', isCurrent: true, isRemote: false },
      { value: 'origin/main', label: 'origin/main', isCurrent: false, isRemote: true },
    ]))
    expect(header.body.data.options.some((row: { value: string }) => row.value === 'origin/HEAD')).toBe(false)
    const branches = await get('worktree/branches', { sourceCwd: repo })
    expect(branches.body.data).toEqual([{ value: 'feature', label: 'feature' }, { value: 'main', label: 'main' }, { value: 'origin/main', label: 'origin/main' }])
    await git(['checkout', '--detach'])
    expect((await get('git/branches', { cwd: repo })).body.data).toMatchObject({ currentBranch: null, detached: true })
    expect(await get('worktree/branches', { sourceCwd: home })).toEqual({ status: 200, body: { data: [] } })
    expect(await get('git/repository-status', { cwd: home })).toEqual({ status: 200, body: { data: { isGitRepo: false, gitRoot: '' } } })
  })

  it('backs up exact untracked paths while leaving non-conflicting files in place', async () => {
    const path = ' leading\tname trailing '
    await git(['checkout', '-b', 'target'])
    await writeFile(join(repo, path), 'target\n')
    await commit('target path')
    await git(['checkout', 'main'])
    await writeFile(join(repo, path), 'local private file\n')
    await writeFile(join(repo, 'unrelated'), 'keep')
    const result = await request('git/checkout', { cwd: repo, branch: 'target' })
    expect(result.status).toBe(200)
    expect(result.body.data).toMatchObject({ currentBranch: 'target', detached: false })
    expect(await readFile(join(repo, path), 'utf8')).toBe('target\n')
    expect(await backupContent(path)).toEqual(['local private file\n'])
    expect(await readFile(join(repo, 'unrelated'), 'utf8')).toBe('keep')
  })

  it('preserves file/directory conflicts before checkout', async () => {
    await git(['checkout', '-b', 'target'])
    await writeFile(join(repo, 'folder'), 'target file\n')
    await commit('file target')
    await git(['checkout', 'main'])
    await mkdir(join(repo, 'folder'))
    await writeFile(join(repo, 'folder', 'local'), 'local nested file')
    const result = await request('git/checkout', { cwd: repo, branch: 'target' })
    expect(result.status).toBe(200)
    expect(await readFile(join(repo, 'folder'), 'utf8')).toBe('target file\n')
    expect(await backupContent('folder/local')).toEqual(['local nested file'])
  })

  it.each(['checkout', 'reset'])('restores moved untracked files when %s fails', async operation => {
    const initial = await git(['rev-parse', 'HEAD'])
    await git(['checkout', '-b', 'target'])
    await writeFile(join(repo, 'collision'), 'tracked target')
    const target = await commit('collision target')
    await git(['checkout', 'main'])
    if (operation === 'reset') await git(['branch', '-f', 'target', initial])
    await writeFile(join(repo, 'collision'), 'original untracked')
    await writeFile(join(repo, '.git', 'index.lock'), 'test failure')
    const result = await request(operation === 'checkout' ? 'git/checkout' : 'git/reset-to-commit', {
      cwd: repo, branch: operation === 'checkout' ? 'target' : 'main', sha: target,
    })
    expect(result.status).toBe(500)
    expect(result.body.error).toContain('index.lock')
    expect(await readFile(join(repo, 'collision'), 'utf8')).toBe('original untracked')
    expect(await git(['rev-parse', 'HEAD'])).toBe(initial)
  })

  it('rejects tracked edits and nonlocal branches before any backup or mutation', async () => {
    const original = await git(['rev-parse', 'HEAD'])
    await writeFile(join(repo, 'tracked.txt'), 'dirty\n')
    for (const path of ['git/checkout', 'git/reset-to-commit']) {
      const result = await request(path, { cwd: repo, branch: 'main', sha: original })
      expect(result.status).toBe(500)
      expect(result.body.error).toContain('已跟踪的改动')
    }
    expect(await git(['rev-parse', 'HEAD'])).toBe(original)
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('dirty\n')
    await git(['checkout', '--', 'tracked.txt'])
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    expect((await request('git/checkout', { cwd: repo, branch: 'origin/main' })).status).toBe(500)
    await expect(readdir(join(repo, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['current', 'legacy'])('recovers a locked branch for the %s Git error without losing edits', async wording => {
    const branch = 'target.v1+fix'
    await git(['branch', branch])
    const locked = join(fixture, 'locked-worktree')
    await git(['worktree', 'add', locked, branch])
    await writeFile(join(locked, 'tracked.txt'), 'preserved worktree edit\n')
    if (wording === 'legacy') {
      const runCommand = commands.runCommand
      vi.spyOn(commands, 'runCommand').mockImplementation(async (...args) => {
        try {
          await runCommand(...args)
        } catch (error) {
          if (!(error instanceof Error)) throw error
          // Only rewrite the genuine failed Git command's wording; recovery still runs real Git.
          throw new Error(error.message.replace('already used by worktree', 'already checked out'))
        }
      })
    }
    const result = await request('git/checkout', { cwd: repo, branch })
    expect(result.status, result.body.error).toBe(200)
    expect(result.body.data.currentBranch).toBe(branch)
    expect(await git(['branch', '--show-current'], locked)).toBe('')
    expect(await readFile(join(locked, 'tracked.txt'), 'utf8')).toBe('preserved worktree edit\n')
  })

  it('resets from detached HEAD, retains the previous tip, and can hide reset history', async () => {
    const initial = await git(['rev-parse', 'HEAD'])
    await writeFile(join(repo, 'tracked.txt'), 'second\n')
    const tip = await commit('second')
    await git(['checkout', '--detach'])
    const result = await request('git/reset-to-commit', { cwd: repo, branch: 'main', sha: initial })
    expect(result.status).toBe(200)
    expect(result.body.data).toMatchObject({ currentBranch: 'main', detached: false, headSha: initial.slice(0, 12) })
    expect(await git(['rev-parse', `refs/codex/header-git-reset-history/main/${tip}`])).toBe(tip)
    expect((await get('git/branch-commits', { cwd: repo, branch: 'main' })).body.data.map((row: { sha: string }) => row.sha).sort()).toEqual([tip, initial].sort())
    expect((await get('git/branch-commits', { cwd: repo, branch: 'main', includeResetHistory: 'false' })).body.data.map((row: { sha: string }) => row.sha)).toEqual([initial])
  })

  it('bounds reset refs at 25 and commit reads at 50', async () => {
    const initial = await git(['rev-parse', 'HEAD'])
    let tip = initial
    for (let index = 0; index < 55; index += 1) {
      tip = await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', `${initial}^{tree}`, '-p', tip, '-m', `fixture-${index}`])
      if (index < 28) await git(['update-ref', `refs/codex/header-git-reset-history/main/${tip}`, tip])
    }
    await git(['update-ref', 'refs/heads/main', tip])
    expect((await get('git/branch-commits', { cwd: repo, branch: 'main' })).body.data).toHaveLength(50)
    expect((await request('git/reset-to-commit', { cwd: repo, branch: 'main', sha: initial })).status).toBe(200)
    const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/codex/header-git-reset-history/main/'])
    expect(refs.split('\n')).toHaveLength(25)
  })

  it('reads rename, binary, and whitespace paths with their line counts', async () => {
    await writeFile(join(repo, 'rename-old'), 'rename content\n')
    await commit('rename source')
    await git(['mv', 'rename-old', 'rename-new'])
    await writeFile(join(repo, 'binary'), Buffer.from([0, 1, 2, 0]))
    await writeFile(join(repo, ' leading\tname trailing '), 'one\ntwo\n')
    const sha = await commit('file details')
    const result = await get('git/commit-files', { cwd: repo, sha })
    expect(result.status).toBe(200)
    expect(result.body.data).toEqual(expect.arrayContaining([
      { path: 'rename-new', previousPath: 'rename-old', status: 'R100', label: 'Renamed', addedLineCount: 0, removedLineCount: 0 },
      { path: 'binary', previousPath: null, status: 'A', label: 'Added', addedLineCount: null, removedLineCount: null },
      { path: ' leading\tname trailing ', previousPath: null, status: 'A', label: 'Added', addedLineCount: 2, removedLineCount: 0 },
    ]))
  })

  it('keeps inherited Git command counts and bounded history inputs', async () => {
    const capture = vi.spyOn(commands, 'runCommandCapture')
    const raw = vi.spyOn(commands, 'runCommandCaptureRaw')
    const run = vi.spyOn(commands, 'runCommand')
    async function audit(operation: () => Promise<unknown>, counts: number[]) {
      capture.mockClear()
      raw.mockClear()
      run.mockClear()
      await operation()
      expect([capture.mock.calls.length, raw.mock.calls.length, run.mock.calls.length]).toEqual(counts)
    }
    await audit(() => service.readRepositoryStatus(repo), [2, 0, 0])
    await audit(() => service.readBranches(repo), [8, 0, 0])
    await audit(() => service.readWorktreeBranches(repo), [2, 0, 0])
    await audit(() => service.readBranchCommits(repo, 'main', false), [3, 0, 0])
    await audit(() => service.readBranchCommits(repo, 'main', true), [4, 0, 0])
    const sha = await git(['rev-parse', 'HEAD'])
    await audit(() => service.readCommitFiles(repo, sha), [2, 2, 0])
    await audit(() => service.checkoutBranch(repo, 'main'), [8, 2, 1])
    await audit(() => service.resetToCommit(repo, 'main', sha), [12, 2, 2])
    await audit(() => service.createWorktree(repo, ''), [1, 0, 1])
    expect(persist).toHaveBeenCalledTimes(1)
  })
})
