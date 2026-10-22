import { normalizePathForUi } from '../pathUtils.js'

export type WorktreeCreateResult = {
  cwd: string
  branch: string | null
  gitRoot: string
}

export type WorktreeBranchOption = {
  value: string
  label: string
  isCurrent?: boolean
  isRemote?: boolean
}

export type GitBranchState = {
  currentBranch: string | null
  headSha: string | null
  headSubject: string | null
  headDate: string | null
  detached: boolean
  dirty: boolean
  gitRoot: string
  options: WorktreeBranchOption[]
}

export type GitCommitOption = {
  sha: string
  shortSha: string
  subject: string
  date: string
}

export type GitCommitFileChange = {
  path: string
  previousPath: string | null
  status: string
  label: string
  addedLineCount: number | null
  removedLineCount: number | null
}

export type GitRepositoryStatus = {
  isGitRepo: boolean
  gitRoot: string
}

export async function createWorktree(sourceCwd: string, baseBranch?: string): Promise<WorktreeCreateResult> {
  const normalizedBaseBranch = (baseBranch ?? '').trim()
  const response = await fetch('/codex-api/worktree/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceCwd,
      baseBranch: normalizedBaseBranch || undefined,
    }),
  })
  const payload = (await response.json()) as { data?: WorktreeCreateResult; error?: string }
  if (!response.ok || !payload.data) {
    throw new Error(payload.error || 'Failed to create worktree')
  }
  return {
    ...payload.data,
    cwd: normalizePathForUi(payload.data.cwd),
    gitRoot: normalizePathForUi(payload.data.gitRoot),
  }
}

export async function createPermanentWorktree(sourceCwd: string, worktreeName: string): Promise<WorktreeCreateResult> {
  const response = await fetch('/codex-api/worktree/create-permanent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceCwd,
      worktreeName,
    }),
  })
  const payload = (await response.json()) as { data?: WorktreeCreateResult; error?: string }
  if (!response.ok || !payload.data) {
    throw new Error(payload.error || 'Failed to create worktree')
  }
  return {
    ...payload.data,
    cwd: normalizePathForUi(payload.data.cwd),
    gitRoot: normalizePathForUi(payload.data.gitRoot),
  }
}

export async function getWorktreeBranchOptions(sourceCwd: string): Promise<WorktreeBranchOption[]> {
  const normalizedSourceCwd = sourceCwd.trim()
  if (!normalizedSourceCwd) return []
  const query = new URLSearchParams({ sourceCwd: normalizedSourceCwd })
  const response = await fetch(`/codex-api/worktree/branches?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load branches')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  const options: WorktreeBranchOption[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const value = typeof record.value === 'string' ? record.value.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: label || value,
    })
  }
  return options
}

export async function getGitBranchState(cwd: string): Promise<GitBranchState> {
  const normalizedCwd = cwd.trim()
  if (!normalizedCwd) {
    return { currentBranch: null, headSha: null, headSubject: null, headDate: null, detached: false, dirty: false, gitRoot: '', options: [] }
  }
  const query = new URLSearchParams({ cwd: normalizedCwd })
  const response = await fetch(`/codex-api/git/branches?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load Git branch state')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  const currentBranchRaw = record.currentBranch
  const currentBranch = typeof currentBranchRaw === 'string' && currentBranchRaw.trim()
    ? currentBranchRaw.trim()
    : null
  const rawList = Array.isArray(record.options) ? record.options : []
  const options: WorktreeBranchOption[] = []
  const seen = new Set<string>()
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const option = item as Record<string, unknown>
    const value = typeof option.value === 'string' ? option.value.trim() : ''
    const label = typeof option.label === 'string' ? option.label.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({
      value,
      label: label || value,
      isCurrent: option.isCurrent === true,
      isRemote: option.isRemote === true,
    })
  }
  if (currentBranch && !seen.has(currentBranch)) {
    options.unshift({ value: currentBranch, label: currentBranch, isCurrent: true })
  }
  const headShaRaw = record.headSha
  const headSubjectRaw = record.headSubject
  const headDateRaw = record.headDate
  const gitRootRaw = record.gitRoot
  return {
    currentBranch,
    headSha: typeof headShaRaw === 'string' && headShaRaw.trim() ? headShaRaw.trim() : null,
    headSubject: typeof headSubjectRaw === 'string' && headSubjectRaw.trim() ? headSubjectRaw.trim() : null,
    headDate: typeof headDateRaw === 'string' && headDateRaw.trim() ? headDateRaw.trim() : null,
    detached: record.detached === true,
    dirty: record.dirty === true,
    gitRoot: typeof gitRootRaw === 'string' ? normalizePathForUi(gitRootRaw) : '',
    options,
  }
}

export async function getGitRepositoryStatus(cwd: string): Promise<GitRepositoryStatus> {
  const normalizedCwd = cwd.trim()
  if (!normalizedCwd) {
    return { isGitRepo: false, gitRoot: '' }
  }
  const query = new URLSearchParams({ cwd: normalizedCwd })
  const response = await fetch(`/codex-api/git/repository-status?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to read Git repository status')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  return {
    isGitRepo: record.isGitRepo === true,
    gitRoot: typeof record.gitRoot === 'string' ? normalizePathForUi(record.gitRoot) : '',
  }
}

export async function checkoutGitBranch(cwd: string, branch: string): Promise<string | null> {
  const response = await fetch('/codex-api/git/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: cwd.trim(),
      branch: branch.trim(),
    }),
  })
  const payload = (await response.json()) as { data?: { currentBranch?: string | null }; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to switch branch')
  }
  const branchName = payload.data?.currentBranch
  return typeof branchName === 'string' && branchName.trim() ? branchName.trim() : null
}

export async function getGitBranchCommits(cwd: string, branch: string, options: { includeResetHistory?: boolean } = {}): Promise<GitCommitOption[]> {
  const normalizedCwd = cwd.trim()
  const normalizedBranch = branch.trim()
  if (!normalizedCwd || !normalizedBranch) return []
  const query = new URLSearchParams({
    cwd: normalizedCwd,
    branch: normalizedBranch,
    includeResetHistory: options.includeResetHistory === false ? 'false' : 'true',
  })
  const response = await fetch(`/codex-api/git/branch-commits?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load branch commits')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  return rawList.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const sha = typeof record.sha === 'string' ? record.sha.trim() : ''
    const shortSha = typeof record.shortSha === 'string' ? record.shortSha.trim() : ''
    const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
    const date = typeof record.date === 'string' ? record.date.trim() : ''
    if (!sha || !shortSha) return []
    return [{ sha, shortSha, subject: subject || shortSha, date }]
  })
}

export async function getGitCommitFiles(cwd: string, sha: string): Promise<GitCommitFileChange[]> {
  const normalizedCwd = cwd.trim()
  const normalizedSha = sha.trim()
  if (!normalizedCwd || !normalizedSha) return []
  const query = new URLSearchParams({
    cwd: normalizedCwd,
    sha: normalizedSha,
  })
  const response = await fetch(`/codex-api/git/commit-files?${query.toString()}`)
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load commit files')
  }
  const rawList = Array.isArray(payload.data) ? payload.data : []
  return rawList.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path : ''
    const previousPath = typeof record.previousPath === 'string' && record.previousPath.length > 0 ? record.previousPath : null
    const status = typeof record.status === 'string' ? record.status.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const addedLineCount = typeof record.addedLineCount === 'number' && Number.isFinite(record.addedLineCount) ? record.addedLineCount : null
    const removedLineCount = typeof record.removedLineCount === 'number' && Number.isFinite(record.removedLineCount) ? record.removedLineCount : null
    if (!path || !status) return []
    return [{ path, previousPath, status, label: label || status, addedLineCount, removedLineCount }]
  })
}

export async function resetGitBranchToCommit(cwd: string, branch: string, sha: string): Promise<GitBranchState> {
  const response = await fetch('/codex-api/git/reset-to-commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cwd: cwd.trim(),
      branch: branch.trim(),
      sha: sha.trim(),
    }),
  })
  const payload = (await response.json()) as { data?: unknown; error?: string }
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to reset branch to commit')
  }
  const record = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : {}
  return {
    currentBranch: typeof record.currentBranch === 'string' && record.currentBranch.trim() ? record.currentBranch.trim() : null,
    headSha: typeof record.headSha === 'string' && record.headSha.trim() ? record.headSha.trim() : null,
    headSubject: typeof record.headSubject === 'string' && record.headSubject.trim() ? record.headSubject.trim() : null,
    headDate: typeof record.headDate === 'string' && record.headDate.trim() ? record.headDate.trim() : null,
    detached: record.detached === true,
    dirty: record.dirty === true,
    gitRoot: typeof record.gitRoot === 'string' ? normalizePathForUi(record.gitRoot) : '',
    options: [],
  }
}
