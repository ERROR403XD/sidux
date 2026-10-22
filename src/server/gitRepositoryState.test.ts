import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { isNotGitRepositoryError, readGitDirectoryStatus, readGitHeaderState } from './gitRepositoryState.js'

const execFileAsync = promisify(execFile)
 let root: string

 beforeEach(async () => {
  root = (await mkdtemp(join(tmpdir(), 'git-repository-state-'))) as string
  await execFileAsync('git', ['init'], { cwd: root })
  await writeFile(join(root, 'file.txt'), 'fixture\n')
  await execFileAsync('git', ['add', 'file.txt'], { cwd: root })
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'], { cwd: root })
 })

 afterEach(async () => {
  await rm(root, { recursive: true, force: true })
 })

 it('reads branch, commit metadata, and dirty state', async () => {
  const state = await readGitHeaderState(root)
  expect(state.currentBranch).toMatch(/^main$|^master$/)
  expect(state.headSha).toMatch(/^[0-9a-f]{12}$/)
  expect(state.headSubject).toBe('initial')
  expect(state.headDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(state).toMatchObject({ detached: false, dirty: false, gitRoot: root })
  await writeFile(join(root, 'file.txt'), 'changed\n')
  await expect(readGitHeaderState(root)).resolves.toMatchObject({ dirty: true })
 })


it('distinguishes missing, non-directory, and existing directories', async () => {
  const nested = join(root, 'nested')
  await mkdir(nested)
  await writeFile(join(root, 'file'), 'x')
  expect(await readGitDirectoryStatus(join(root, 'missing'))).toBe('missing')
  expect(await readGitDirectoryStatus(join(root, 'file'))).toBe('not-directory')
  expect(await readGitDirectoryStatus(nested)).toBe('ok')
  const nonGit = (await mkdir(join(tmpdir(), `non-git-${process.pid}-${Date.now()}`), { recursive: true })) as string
  expect(await readGitDirectoryStatus(nonGit)).toBe('ok')
  expect(isNotGitRepositoryError(new Error('fatal: not a git repository'))).toBe(true)
  await rm(nonGit, { recursive: true, force: true })
 })
