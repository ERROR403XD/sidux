import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { runCommandCapture } from './commandExecution.js'
import { getErrorMessage } from './httpUtils.js'

export type GitHeaderState = {
  currentBranch: string | null
  headSha: string | null
  headSubject: string | null
  headDate: string | null
  detached: boolean
  dirty: boolean
  gitRoot: string
}

export function isNotGitRepositoryError(error: unknown): boolean {
  const message = getErrorMessage(error, '').toLowerCase()
  return (
    message.includes('not a git repository') ||
    message.includes('fatal: not a git repository')
  )
}

export async function readGitHeaderState(cwd: string): Promise<GitHeaderState> {
  const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
  const currentBranchRaw = await runCommandCapture('git', ['branch', '--show-current'], { cwd: gitRoot })
  const currentBranch = currentBranchRaw.trim() || null
  const headShaRaw = await runCommandCapture('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: gitRoot })
  const headCommitRaw = await runCommandCapture('git', ['show', '-s', '--date=short', '--format=%cd%x09%s', 'HEAD'], { cwd: gitRoot })
  const [headDate = '', ...headSubjectParts] = headCommitRaw.split('\t')
  const statusRaw = await runCommandCapture('git', ['status', '--porcelain'], { cwd: gitRoot })
  return {
    currentBranch,
    headSha: headShaRaw.trim() || null,
    headSubject: headSubjectParts.join('\t').trim() || null,
    headDate: headDate.trim() || null,
    detached: !currentBranch,
    dirty: statusRaw.trim().length > 0,
    gitRoot,
  }
}

export type GitDirectoryStatus = 'ok' | 'missing' | 'not-directory'

export async function readGitDirectoryStatus(rawCwd: string): Promise<GitDirectoryStatus> {
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
  try {
    const cwdInfo = await stat(cwd)
    if (!cwdInfo.isDirectory()) return 'not-directory'
  } catch {
    return 'missing'
  }
  try {
    await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    return 'ok'
  } catch (error) {
    if (!isNotGitRepositoryError(error)) throw error
    return 'ok'
  }
}
