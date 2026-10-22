import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { runCommand, runCommandCapture, runCommandCaptureRaw } from './commandExecution.js'
import { isNotGitRepositoryError, readGitDirectoryStatus, readGitHeaderState, type GitHeaderState } from './gitRepositoryState.js'
import { getErrorMessage } from './httpUtils.js'

export class GitWorkspaceError extends Error {
  constructor(readonly code: 'invalid-input' | 'missing-directory' | 'path-exists', message: string) {
    super(message)
  }
}

type GitWorkspaceDependencies = {
  getCodexHomeDir: () => string
  persistWorkspaceRoot: (cwd: string) => Promise<void>
}

function isMissingHeadError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return (
    message.includes("not a valid object name: 'head'") ||
    message.includes('not a valid object name: head') ||
    message.includes('invalid reference: head')
  )
}

async function ensureRepoHasInitialCommit(repoRoot: string): Promise<void> {
  const agentsPath = join(repoRoot, 'AGENTS.md')
  try {
    await stat(agentsPath)
  } catch {
    await writeFile(agentsPath, '', 'utf8')
  }

  await runCommand('git', ['add', 'AGENTS.md'], { cwd: repoRoot })
  await runCommand(
    'git',
    ['-c', 'user.name=Codex', '-c', 'user.email=codex@local', 'commit', '-m', 'Initialize repository for worktree support'],
    { cwd: repoRoot },
  )
}

function normalizeBranchRefName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('refs/heads/')) return trimmed.slice('refs/heads/'.length)
  if (trimmed.startsWith('refs/remotes/')) return trimmed.slice('refs/remotes/'.length)
  return trimmed
}

function toHeaderGitResetHistoryRef(branchName: string, commitSha: string): string {
  return `refs/codex/header-git-reset-history/${branchName}/${commitSha}`
}

const HEADER_GIT_RESET_HISTORY_REF_LIMIT = 25
const HEADER_GIT_UNTRACKED_BACKUP_DIR = '.codex/untracked-backups'

async function assertLocalGitBranch(repoRoot: string, branchName: string): Promise<void> {
  await runCommandCapture('git', ['show-ref', '--verify', `refs/heads/${branchName}`], { cwd: repoRoot })
}

function splitGitPathList(raw: string): string[] {
  return raw
    .split('\0')
    .filter((entry) => entry.length > 0)
}

function isSafeGitRelativePath(filePath: string): boolean {
  return Boolean(filePath) && !isAbsolute(filePath) && !filePath.split('/').includes('..')
}

function resolveGitRelativePath(repoRoot: string, filePath: string): string {
  return join(repoRoot, ...filePath.split('/'))
}

type PreservedUntrackedFile = {
  filePath: string
  sourcePath: string
  backupPath: string
}

function gitPathsConflict(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

async function removeEmptyGitRelativeParents(repoRoot: string, filePath: string): Promise<void> {
  let current = dirname(resolveGitRelativePath(repoRoot, filePath))
  while (current !== repoRoot && current.startsWith(`${repoRoot}/`)) {
    try {
      await rm(current, { recursive: false })
    } catch {
      return
    }
    current = dirname(current)
  }
}

async function rollbackPreservedUntrackedFiles(entries: PreservedUntrackedFile[]): Promise<void> {
  for (const entry of entries.slice().reverse()) {
    try {
      if (existsSync(entry.backupPath) && !existsSync(entry.sourcePath)) {
        await mkdir(dirname(entry.sourcePath), { recursive: true })
        await rename(entry.backupPath, entry.sourcePath)
      }
    } catch {
      // Preserve the original git failure; best-effort rollback avoids masking it.
    }
  }
}

async function preserveUntrackedFilesForGitTarget(repoRoot: string, targetRef: string): Promise<PreservedUntrackedFile[]> {
  const [untrackedRaw, targetTreeRaw] = await Promise.all([
    runCommandCaptureRaw('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot }),
    runCommandCaptureRaw('git', ['ls-tree', '-r', '--name-only', '-z', `${targetRef}^{tree}`], { cwd: repoRoot }),
  ])
  const targetPaths = splitGitPathList(targetTreeRaw)
  const conflictingUntrackedPaths = splitGitPathList(untrackedRaw)
    .filter((filePath) => isSafeGitRelativePath(filePath) && targetPaths.some((targetPath) => gitPathsConflict(filePath, targetPath)))
  if (conflictingUntrackedPaths.length === 0) return []

  const backupRoot = join(repoRoot, HEADER_GIT_UNTRACKED_BACKUP_DIR, new Date().toISOString().replace(/[:.]/g, '-'))
  const movedFiles: PreservedUntrackedFile[] = []
  for (const filePath of conflictingUntrackedPaths) {
    const sourcePath = resolveGitRelativePath(repoRoot, filePath)
    const backupPath = join(backupRoot, ...filePath.split('/'))
    await mkdir(dirname(backupPath), { recursive: true })
    await rename(sourcePath, backupPath)
    movedFiles.push({ filePath, sourcePath, backupPath })
    await removeEmptyGitRelativeParents(repoRoot, filePath)
  }
  return movedFiles
}

async function withPreservedUntrackedFilesForGitTarget(repoRoot: string, targetRef: string, operation: () => Promise<void>): Promise<void> {
  const movedFiles = await preserveUntrackedFilesForGitTarget(repoRoot, targetRef)
  try {
    await operation()
  } catch (error) {
    await rollbackPreservedUntrackedFiles(movedFiles)
    throw error
  }
}

async function checkoutGitBranchWithWorktreeRecovery(repoRoot: string, branchName: string): Promise<void> {
  await withPreservedUntrackedFilesForGitTarget(repoRoot, branchName, async () => {
    try {
      await runCommand('git', ['checkout', branchName], { cwd: repoRoot })
    } catch (checkoutError) {
      const blockingWorktreePath = extractBranchLockedWorktreePath(checkoutError, branchName)
      if (!blockingWorktreePath) {
        throw checkoutError
      }
      await runCommand('git', ['checkout', '--detach'], { cwd: blockingWorktreePath })
      await runCommand('git', ['checkout', branchName], { cwd: repoRoot })
    }
  })
}

async function pruneHeaderGitResetHistoryRefs(repoRoot: string, branchName: string): Promise<void> {
  const resetHistoryRefPrefix = `refs/codex/header-git-reset-history/${branchName}/`
  const refsRaw = await runCommandCapture(
    'git',
    ['for-each-ref', '--sort=-creatordate', '--format=%(refname)', resetHistoryRefPrefix],
    { cwd: repoRoot },
  ).catch(() => '')
  const refs = refsRaw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const staleRefs = refs.slice(HEADER_GIT_RESET_HISTORY_REF_LIMIT)
  for (const refName of staleRefs) {
    await runCommand('git', ['update-ref', '-d', refName], { cwd: repoRoot })
  }
}

async function assertNoTrackedGitChanges(repoRoot: string): Promise<void> {
  const statusRaw = await runCommandCapture('git', ['status', '--porcelain'], { cwd: repoRoot })
  const trackedChanges = statusRaw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith('?? '))
  if (trackedChanges.length > 0) {
    throw new Error('切换分支或重置前，请先提交、Stash 或丢弃已跟踪的改动；未跟踪文件仅在会被覆盖时需处理。')
  }
}

function extractBranchLockedWorktreePath(error: unknown, branchName: string): string {
  const message = getErrorMessage(error, '')
  if (!message || !branchName) return ''
  const escapedBranch = branchName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`'${escapedBranch}' is already (?:checked out|used by worktree) at '([^']+)'`, 'u')
  const match = pattern.exec(message)
  return match?.[1]?.trim() ?? ''
}

function toPermanentWorktreeBranchNameDraft(worktreeName: string): string {
  const sanitized = worktreeName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/\.+/gu, '.')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
  return sanitized || 'worktree'
}

async function isValidGitBranchName(gitRoot: string, branchName: string): Promise<boolean> {
  try {
    await runCommand('git', ['check-ref-format', '--branch', branchName], { cwd: gitRoot })
    return true
  } catch {
    return false
  }
}

async function doesLocalGitBranchExist(gitRoot: string, branchName: string): Promise<boolean> {
  try {
    await runCommand('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { cwd: gitRoot })
    return true
  } catch {
    return false
  }
}

async function allocatePermanentWorktreeBranchName(gitRoot: string, worktreeName: string): Promise<string> {
  const base = toPermanentWorktreeBranchNameDraft(worktreeName)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    if (!await isValidGitBranchName(gitRoot, candidate)) continue
    if (!await doesLocalGitBranchExist(gitRoot, candidate)) return candidate
  }
  throw new Error('Failed to allocate a unique branch name for worktree')
}

async function rollbackCreatedWorktree(
  gitRoot: string,
  worktreeCwd: string,
  cleanupDirectory?: string,
  branchName?: string,
): Promise<void> {
  try {
    await runCommand('git', ['worktree', 'remove', '--force', worktreeCwd], { cwd: gitRoot })
  } catch {
    await rm(worktreeCwd, { recursive: true, force: true }).catch(() => undefined)
  }

  if (cleanupDirectory && cleanupDirectory !== worktreeCwd) {
    await rm(cleanupDirectory, { recursive: true, force: true }).catch(() => undefined)
  }

  if (branchName) {
    await runCommand('git', ['branch', '-D', branchName], { cwd: gitRoot }).catch(() => undefined)
  }
}

export function createGitWorkspaceService({ getCodexHomeDir, persistWorkspaceRoot }: GitWorkspaceDependencies) {
  async function createWorktree(rawSourceCwd: string, baseBranch: string) {
    const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
    try {
      const sourceInfo = await stat(sourceCwd)
      if (!sourceInfo.isDirectory()) {
        throw new GitWorkspaceError('invalid-input', 'sourceCwd is not a directory')
      }
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error
      throw new GitWorkspaceError('missing-directory', 'sourceCwd does not exist')
    }
    let gitRoot = ''
    try {
      gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
    } catch (error) {
      if (!isNotGitRepositoryError(error)) throw error
      await runCommand('git', ['init'], { cwd: sourceCwd })
      gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
    }
    const repoName = basename(gitRoot) || 'repo'
    const worktreesRoot = join(getCodexHomeDir(), 'worktrees')
    await mkdir(worktreesRoot, { recursive: true })
    // Preserve the existing home/worktrees/<id>/<repoName> layout.
    let worktreeId = ''
    let worktreeParent = ''
    let worktreeCwd = ''
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = randomBytes(2).toString('hex')
      const parent = join(worktreesRoot, candidate)
      try {
        await stat(parent)
        continue
      } catch {
        worktreeId = candidate
        worktreeParent = parent
        worktreeCwd = join(parent, repoName)
        break
      }
    }
    if (!worktreeId || !worktreeParent || !worktreeCwd) {
      throw new Error('Failed to allocate a unique worktree id')
    }
    const startPoint = baseBranch || 'HEAD'
    await mkdir(worktreeParent, { recursive: true })
    try {
      await runCommand('git', ['worktree', 'add', '--detach', worktreeCwd, startPoint], { cwd: gitRoot })
    } catch (error) {
      if (!isMissingHeadError(error)) throw error
      await ensureRepoHasInitialCommit(gitRoot)
      await runCommand('git', ['worktree', 'add', '--detach', worktreeCwd, startPoint], { cwd: gitRoot })
    }
    try {
      await persistWorkspaceRoot(worktreeCwd)
    } catch (error) {
      await rollbackCreatedWorktree(gitRoot, worktreeCwd, worktreeParent)
      throw error
    }
    return {
      cwd: worktreeCwd,
      branch: null,
      gitRoot,
    }
  }

  async function createPermanentWorktree(rawSourceCwd: string, rawWorktreeName: string) {
    if (rawWorktreeName.includes('/') || rawWorktreeName.includes('\\') || rawWorktreeName === '.' || rawWorktreeName === '..') {
      throw new GitWorkspaceError('invalid-input', 'Worktree name must be a single folder name')
    }
    const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
    try {
      const sourceInfo = await stat(sourceCwd)
      if (!sourceInfo.isDirectory()) {
        throw new GitWorkspaceError('invalid-input', 'sourceCwd is not a directory')
      }
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error
      throw new GitWorkspaceError('missing-directory', 'sourceCwd does not exist')
    }
    let gitRoot = ''
    try {
      gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
    } catch (error) {
      if (!isNotGitRepositoryError(error)) throw error
      await runCommand('git', ['init'], { cwd: sourceCwd })
      gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
    }
    const worktreeCwd = join(dirname(gitRoot), rawWorktreeName)
    try {
      await stat(worktreeCwd)
      throw new GitWorkspaceError('path-exists', 'Worktree folder already exists')
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error
      // Expected for a new worktree path.
    }
    const branchName = await allocatePermanentWorktreeBranchName(gitRoot, rawWorktreeName)
    try {
      await runCommand('git', ['worktree', 'add', '-b', branchName, worktreeCwd, 'HEAD'], { cwd: gitRoot })
    } catch (error) {
      if (!isMissingHeadError(error)) throw error
      await ensureRepoHasInitialCommit(gitRoot)
      await runCommand('git', ['worktree', 'add', '-b', branchName, worktreeCwd, 'HEAD'], { cwd: gitRoot })
    }
    try {
      await persistWorkspaceRoot(worktreeCwd)
    } catch (error) {
      await rollbackCreatedWorktree(gitRoot, worktreeCwd, undefined, branchName)
      throw error
    }
    return {
      cwd: worktreeCwd,
      branch: branchName,
      gitRoot,
    }
  }

  async function readWorktreeBranches(rawSourceCwd: string) {
    const sourceCwd = isAbsolute(rawSourceCwd) ? rawSourceCwd : resolve(rawSourceCwd)
    try {
      const sourceInfo = await stat(sourceCwd)
      if (!sourceInfo.isDirectory()) {
        throw new GitWorkspaceError('invalid-input', 'sourceCwd is not a directory')
      }
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error
      throw new GitWorkspaceError('missing-directory', 'sourceCwd does not exist')
    }
    let gitRoot = ''
    try {
      gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd: sourceCwd })
    } catch (error) {
      if (!isNotGitRepositoryError(error)) throw error
      return []
    }
    const output = await runCommandCapture(
      'git',
      ['for-each-ref', '--format=%(committerdate:unix)\t%(refname)', 'refs/heads', 'refs/remotes'],
      { cwd: gitRoot },
    )
    const branchActivityByName = new Map<string, number>()
    for (const line of output.split('\n')) {
      const [rawTimestamp = '', rawRefName = ''] = line.split('\t')
      const normalized = normalizeBranchRefName(rawRefName)
      if (!normalized || normalized === 'origin/HEAD') continue
      const parsedTimestamp = Number.parseInt(rawTimestamp.trim(), 10)
      const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0
      const current = branchActivityByName.get(normalized) ?? Number.MIN_SAFE_INTEGER
      if (timestamp > current) {
        branchActivityByName.set(normalized, timestamp)
      }
    }
    const branches = Array.from(branchActivityByName.entries())
      .map(([value]) => ({ value, label: value }))
      .sort((a, b) => {
        const aActivity = branchActivityByName.get(a.value) ?? 0
        const bActivity = branchActivityByName.get(b.value) ?? 0
        if (bActivity !== aActivity) return bActivity - aActivity
        return a.value.localeCompare(b.value)
      })
    return branches
  }

  async function checkoutBranch(rawCwd: string, targetBranch: string) {
    const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
    try {
      const cwdInfo = await stat(cwd)
      if (!cwdInfo.isDirectory()) {
        throw new GitWorkspaceError('invalid-input', 'cwd is not a directory')
      }
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error
      throw new GitWorkspaceError('missing-directory', 'cwd does not exist')
    }
    const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    await assertNoTrackedGitChanges(gitRoot)
    await assertLocalGitBranch(gitRoot, targetBranch)
    await checkoutGitBranchWithWorktreeRecovery(gitRoot, targetBranch)
    return await readGitHeaderState(gitRoot)
  }

  async function readBranchCommits(rawCwd: string, branch: string, includeResetHistory: boolean) {
    const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
    const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    await runCommandCapture('git', ['rev-parse', '--verify', `${branch}^{commit}`], { cwd: gitRoot })
    let resetHistoryRefs: string[] = []
    if (includeResetHistory) {
      const resetHistoryRefPrefix = `refs/codex/header-git-reset-history/${branch}/`
      const resetHistoryRefsRaw = await runCommandCapture(
        'git',
        ['for-each-ref', '--sort=-creatordate', '--format=%(refname)', resetHistoryRefPrefix],
        { cwd: gitRoot },
      ).catch(() => '')
      resetHistoryRefs = resetHistoryRefsRaw
        .split('\n')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, HEADER_GIT_RESET_HISTORY_REF_LIMIT)
    }
    const output = await runCommandCapture(
      'git',
      ['log', '-n', '50', '--date=short', '--format=%H%x09%h%x09%cd%x09%s', branch, ...resetHistoryRefs],
      { cwd: gitRoot },
    )
    const commits = output.split('\n').flatMap((line) => {
      const [sha = '', shortSha = '', date = '', ...subjectParts] = line.split('\t')
      const subject = subjectParts.join('\t').trim()
      return sha.trim() && shortSha.trim()
        ? [{ sha: sha.trim(), shortSha: shortSha.trim(), date: date.trim(), subject: subject || shortSha.trim() }]
        : []
    })
    return commits
  }

  async function readCommitFiles(rawCwd: string, sha: string) {
    const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
    const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    await runCommandCapture('git', ['rev-parse', '--verify', `${sha}^{commit}`], { cwd: gitRoot })
    const output = await runCommandCaptureRaw(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', sha],
      { cwd: gitRoot },
    )
    const numstatOutput = await runCommandCaptureRaw(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-M', '-z', sha],
      { cwd: gitRoot },
    )
    const splitNumstatRecord = (record: string): { addedRaw: string; removedRaw: string; path: string } | null => {
      const firstTab = record.indexOf('\t')
      if (firstTab < 0) return null
      const secondTab = record.indexOf('\t', firstTab + 1)
      if (secondTab < 0) return null
      return {
        addedRaw: record.slice(0, firstTab),
        removedRaw: record.slice(firstTab + 1, secondTab),
        path: record.slice(secondTab + 1),
      }
    }
    const lineCountsByPath = new Map<string, { addedLineCount: number | null; removedLineCount: number | null }>()
    const numstatRecords = splitGitPathList(numstatOutput)
    for (let index = 0; index < numstatRecords.length; index += 1) {
      const record = splitNumstatRecord(numstatRecords[index] ?? '')
      if (!record) continue
      const { addedRaw, removedRaw } = record
      const path = record.path || numstatRecords[index + 2] || numstatRecords[index + 1] || ''
      if (!record.path) index += 2
      if (!path) continue
      const addedLineCount = /^\d+$/.test(addedRaw) ? Number(addedRaw) : null
      const removedLineCount = /^\d+$/.test(removedRaw) ? Number(removedRaw) : null
      lineCountsByPath.set(path, { addedLineCount, removedLineCount })
    }
    const nameStatusRecords = splitGitPathList(output)
    const files: Array<{
      path: string
      previousPath: string | null
      status: string
      label: string
      addedLineCount: number | null
      removedLineCount: number | null
    }> = []
    for (let index = 0; index < nameStatusRecords.length; index += 1) {
      const status = nameStatusRecords[index] ?? ''
      if (!status) continue
      const statusKind = status.charAt(0)
      const isRenameOrCopy = statusKind === 'R' || statusKind === 'C'
      const previousPath = isRenameOrCopy ? nameStatusRecords[index + 1] || null : null
      const path = isRenameOrCopy ? nameStatusRecords[index + 2] || '' : nameStatusRecords[index + 1] || ''
      index += isRenameOrCopy ? 2 : 1
      if (!path) continue
      const label = statusKind === 'A'
        ? 'Added'
        : statusKind === 'D'
          ? 'Deleted'
          : statusKind === 'R'
            ? 'Renamed'
            : statusKind === 'C'
              ? 'Copied'
              : statusKind === 'M'
                ? 'Modified'
                : status
      const lineCounts = lineCountsByPath.get(path) ?? { addedLineCount: null, removedLineCount: null }
      files.push({ path, previousPath, status, label, ...lineCounts })
    }
    return files
  }

  async function resetToCommit(rawCwd: string, branch: string, sha: string) {
    const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
    const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    await assertNoTrackedGitChanges(gitRoot)
    await assertLocalGitBranch(gitRoot, branch)
    const currentBranch = (await runCommandCapture('git', ['branch', '--show-current'], { cwd: gitRoot })).trim()
    if (currentBranch && currentBranch !== branch) {
      await checkoutGitBranchWithWorktreeRecovery(gitRoot, branch)
    } else if (!currentBranch) {
      await checkoutGitBranchWithWorktreeRecovery(gitRoot, branch)
    }
    const previousTip = await runCommandCapture('git', ['rev-parse', 'HEAD'], { cwd: gitRoot })
    const targetSha = await runCommandCapture('git', ['rev-parse', '--verify', `${sha}^{commit}`], { cwd: gitRoot })
    await runCommand('git', ['update-ref', toHeaderGitResetHistoryRef(branch, previousTip.trim()), previousTip.trim()], { cwd: gitRoot })
    await pruneHeaderGitResetHistoryRefs(gitRoot, branch)
    await withPreservedUntrackedFilesForGitTarget(gitRoot, targetSha.trim(), async () => {
      await runCommand('git', ['reset', '--hard', targetSha.trim()], { cwd: gitRoot })
    })
    return await readGitHeaderState(gitRoot)
  }

  async function readBranches(rawCwd: string) {
    const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
    const directoryStatus = await readGitDirectoryStatus(cwd)
    if (directoryStatus === 'missing') {
      throw new GitWorkspaceError('missing-directory', 'cwd does not exist')
    }
    if (directoryStatus === 'not-directory') {
      throw new GitWorkspaceError('invalid-input', 'cwd is not a directory')
    }
    let gitRoot = ''
    try {
      gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    } catch (error) {
      if (!isNotGitRepositoryError(error)) throw error
      return { currentBranch: null, options: [] }
    }
    const state: GitHeaderState = await readGitHeaderState(gitRoot)
    const currentBranch = state.currentBranch
    const output = await runCommandCapture(
      'git',
      ['for-each-ref', '--format=%(committerdate:unix)\t%(refname)\t%(objectname)', 'refs/heads', 'refs/remotes'],
      { cwd: gitRoot },
    )
    const branchActivityByName = new Map<string, { timestamp: number; isRemote: boolean }>()
    for (const line of output.split('\n')) {
      const [rawTimestamp = '', rawRefName = ''] = line.split('\t')
      const normalized = normalizeBranchRefName(rawRefName)
      if (!normalized || normalized === 'origin/HEAD') continue
      const parsedTimestamp = Number.parseInt(rawTimestamp.trim(), 10)
      const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0
      const isRemote = rawRefName.trim().startsWith('refs/remotes/')
      const current = branchActivityByName.get(normalized)
      if (!current || timestamp > current.timestamp) {
        branchActivityByName.set(normalized, { timestamp, isRemote })
      }
    }
    if (currentBranch && !branchActivityByName.has(currentBranch)) {
      branchActivityByName.set(currentBranch, { timestamp: Number.MAX_SAFE_INTEGER, isRemote: false })
    }
    const options = Array.from(branchActivityByName.entries())
      .map(([value, metadata]) => ({
        value,
        label: value,
        isCurrent: value === currentBranch,
        isRemote: metadata.isRemote,
      }))
      .sort((a, b) => {
        const aActivity = branchActivityByName.get(a.value)?.timestamp ?? 0
        const bActivity = branchActivityByName.get(b.value)?.timestamp ?? 0
        if (bActivity !== aActivity) return bActivity - aActivity
        return a.value.localeCompare(b.value)
      })
    return { ...state, options }
  }

  async function readRepositoryStatus(rawCwd: string) {
    const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
    const directoryStatus = await readGitDirectoryStatus(cwd)
    if (directoryStatus === 'not-directory') {
      throw new GitWorkspaceError('invalid-input', 'cwd is not a directory')
    }
    if (directoryStatus === 'missing') {
      throw new GitWorkspaceError('missing-directory', 'cwd does not exist')
    }
    try {
      const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
      return { isGitRepo: true, gitRoot }
    } catch (error) {
      if (!isNotGitRepositoryError(error)) throw error
      return { isGitRepo: false, gitRoot: '' }
    }
  }

  return { createWorktree, createPermanentWorktree, readWorktreeBranches, checkoutBranch, readBranchCommits, readCommitFiles, resetToCommit, readBranches, readRepositoryStatus }
}
