import { chmod, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runCommandCapture, runCommandCaptureBuffer } from './commandExecution.js'
import { asRecord } from './httpUtils.js'
import { readNonEmptyString } from './runtimePaths.js'
import { parseApplyPatchInput } from './sessionItemRecovery.js'
import type { ThreadHistory } from './threadHistory.js'
import { captureFileChangeSnapshot } from './fileChangeSnapshot.js'

type FileRollbackInput = {
  threadId: string
  turnId: string
  cwd: string
  action: 'undo' | 'redo'
  scope: 'single_turn' | 'turn_and_later'
  patchIds?: Set<string>
}

type FileRollbackDependencies = {
  history: Pick<ThreadHistory, 'assertRollbackAllowed'>
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

function extractFilePathsFromCommand(cmd: string, cwd: string): string[] {
  const paths: string[] = []
  const absPathPattern = /(?:^|\s|>>|>|<)(\/?(?:Users|home|tmp|var|etc|root)\/[^\s;|&><"']+)/g
  let match: RegExpExecArray | null
  while ((match = absPathPattern.exec(cmd)) !== null) {
    const p = match[1]?.trim()
    if (p && !p.endsWith('/') && !p.startsWith('-')) paths.push(p)
  }

  const redirectPattern = /(?:>>?|cat\s*>\s*)([^\s;|&><"']+)/g
  while ((match = redirectPattern.exec(cmd)) !== null) {
    const p = match[1]?.trim()
    if (p && !p.startsWith('-') && !p.startsWith('/dev/')) {
      paths.push(isAbsolute(p) ? p : join(cwd, p))
    }
  }

  return [...new Set(paths)]
}

type CollectedTurnFileInfo = {
  patchInputs: { callId: string; input: string }[]
  commandFilePaths: string[]
}

async function capturePatchFiles(cwd: string, changes: ReturnType<typeof parseApplyPatchInput>) {
  const paths = changes.flatMap(change => [change.path, ...(change.movedToPath ? [change.movedToPath] : [])])
    .map(path => isAbsolute(path) ? path : join(cwd, path))
  return captureFileChangeSnapshot(paths)
}

async function restoreHeadFile(gitRoot: string, relativePath: string, filePath: string): Promise<void> {
  const tree = await runCommandCaptureBuffer('git', ['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', relativePath], { cwd: gitRoot })
  const mode = tree.toString().split(' ')[0]
  if (!['100644', '100755', '120000'].includes(mode ?? '')) throw new Error('Missing HEAD file')
  const content = await runCommandCaptureBuffer('git', ['show', `HEAD:${relativePath}`], { cwd: gitRoot })
  await mkdir(dirname(filePath), { recursive: true })
  await rm(filePath, { force: true })
  if (mode === '120000') await symlink(content.toString(), filePath)
  else {
    await writeFile(filePath, content)
    await chmod(filePath, mode === '100755' ? 0o755 : 0o644)
  }
}

function collectFileChangesForTurns(
  sessionLogRaw: string,
  turnIdsToRevert: Set<string>,
  cwd: string,
): Map<string, CollectedTurnFileInfo> {
  let currentTurnId = ''
  const infoByTurnId = new Map<string, CollectedTurnFileInfo>()

  for (const line of sessionLogRaw.split('\n')) {
    if (!line.trim()) continue
    let row: Record<string, unknown> | null = null
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    if (row.type === 'turn_context') {
      const p = asRecord(row.payload)
      currentTurnId = readNonEmptyString(p?.turn_id) || currentTurnId
      continue
    }
    if (row.type === 'event_msg') {
      const p = asRecord(row.payload)
      if (p?.type === 'task_started') {
        currentTurnId = readNonEmptyString(p.turn_id) || currentTurnId
      }
      continue
    }

    if (row.type !== 'response_item' || !currentTurnId || !turnIdsToRevert.has(currentTurnId)) continue
    const payload = asRecord(row.payload)
    if (!payload) continue

    let info = infoByTurnId.get(currentTurnId)
    if (!info) {
      info = { patchInputs: [], commandFilePaths: [] }
      infoByTurnId.set(currentTurnId, info)
    }

    if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch' && payload.status === 'completed') {
      const input = typeof payload.input === 'string' ? payload.input : ''
      const callId = readNonEmptyString(payload.call_id)
      if (input && callId) {
        info.patchInputs.push({ callId, input })
      }
    }

    if (payload.type === 'function_call' && payload.name === 'exec_command') {
      let cmd = ''
      try {
        const args = JSON.parse(payload.arguments as string) as Record<string, unknown>
        cmd = typeof args.cmd === 'string' ? args.cmd : ''
      } catch { /* empty */ }
      if (cmd) {
        const extracted = extractFilePathsFromCommand(cmd, cwd)
        for (const p of extracted) {
          if (!info.commandFilePaths.includes(p)) info.commandFilePaths.push(p)
        }
      }
    }
  }

  return infoByTurnId
}

function reverseV4aDiff(fileContent: string, diffText: string): string | null {
  const fileLines = fileContent.split('\n')
  const rawDiffLines = diffText.split('\n')
  while (rawDiffLines.length > 0 && rawDiffLines[rawDiffLines.length - 1]?.trim() === '') rawDiffLines.pop()
  const diffLines = rawDiffLines
  const result = [...fileLines]

  type DiffEntry = { type: 'context' | 'add' | 'remove'; text: string }
  const hunks: DiffEntry[][] = []
  let currentHunk: DiffEntry[] | null = null

  for (const dl of diffLines) {
    if (dl.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk)
      currentHunk = []
      continue
    }
    if (!currentHunk) continue
    if (dl.startsWith('+')) {
      currentHunk.push({ type: 'add', text: dl.slice(1) })
    } else if (dl.startsWith('-')) {
      currentHunk.push({ type: 'remove', text: dl.slice(1) })
    } else if (dl.startsWith(' ')) {
      currentHunk.push({ type: 'context', text: dl.slice(1) })
    } else {
      currentHunk.push({ type: 'context', text: dl })
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const hunk = hunks[hi]!
    const expectedSequence = hunk
      .filter((e) => e.type === 'context' || e.type === 'add')
      .map((e) => e.text)

    if (expectedSequence.length === 0) continue

    let seqStart = -1
    outer: for (let ri = result.length - expectedSequence.length; ri >= 0; ri--) {
      for (let si = 0; si < expectedSequence.length; si++) {
        if (result[ri + si] !== expectedSequence[si]) continue outer
      }
      seqStart = ri
      break
    }

    if (seqStart < 0) return null

    const newLines: string[] = []
    let seqIdx = 0
    for (const entry of hunk) {
      if (entry.type === 'context') {
        newLines.push(result[seqStart + seqIdx]!)
        seqIdx++
      } else if (entry.type === 'add') {
        seqIdx++
      } else if (entry.type === 'remove') {
        newLines.push(entry.text)
      }
    }

    result.splice(seqStart, expectedSequence.length, ...newLines)
  }

  return result.join('\n')
}

function applyV4aDiff(fileContent: string, diffText: string): string | null {
  const fileLines = fileContent === '' ? [] : fileContent.split('\n')
  const rawDiffLines = diffText.split('\n')
  while (rawDiffLines.length > 0 && rawDiffLines[rawDiffLines.length - 1]?.trim() === '') rawDiffLines.pop()
  const result = [...fileLines]

  type DiffEntry = { type: 'context' | 'add' | 'remove'; text: string }
  type DiffHunk = { oldStart: number | null; anchor: string; entries: DiffEntry[] }
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null

  for (const dl of rawDiffLines) {
    const hunkMatch = dl.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u)
    if (hunkMatch || dl === '@@' || dl.startsWith('@@ ')) {
      if (currentHunk) hunks.push(currentHunk)
      currentHunk = {
        oldStart: hunkMatch ? Math.max(Number(hunkMatch[1] ?? '1') - 1, 0) : null,
        anchor: hunkMatch ? '' : dl.slice(3),
        entries: [],
      }
      continue
    }
    if (dl === '*** End of File') continue
    if (!currentHunk) {
      if (!dl.startsWith('+') && !dl.startsWith('-') && !dl.startsWith(' ')) return null
      currentHunk = { oldStart: null, anchor: '', entries: [] }
    }
    if (dl.startsWith('+')) {
      currentHunk.entries.push({ type: 'add', text: dl.slice(1) })
    } else if (dl.startsWith('-')) {
      currentHunk.entries.push({ type: 'remove', text: dl.slice(1) })
    } else if (dl.startsWith(' ')) {
      currentHunk.entries.push({ type: 'context', text: dl.slice(1) })
    } else {
      currentHunk.entries.push({ type: 'context', text: dl })
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  // apply_patch hunks have no line numbers; match them forward in patch order.
  let nextStart = 0
  for (const hunk of hunks) {
    let preferredPosition = hunk.oldStart ?? nextStart
    if (hunk.anchor) {
      const anchorIndex = result.indexOf(hunk.anchor, nextStart)
      if (anchorIndex < 0) return null
      preferredPosition = anchorIndex + 1
    }
    const expectedSequence = hunk.entries
      .filter((e) => e.type === 'context' || e.type === 'remove')
      .map((e) => e.text)

    let seqStart = -1
    if (expectedSequence.length === 0) {
      seqStart = Math.min(preferredPosition, result.length)
    } else {
      const maxStart = result.length - expectedSequence.length
      if (maxStart < 0) return null
      const preferredStart = Math.min(preferredPosition, Math.max(maxStart, 0))
      const candidateStarts = [
        ...Array.from({ length: maxStart + 1 }, (_, index) => preferredStart + index).filter((value) => value <= maxStart),
        ...(hunk.oldStart === null ? [] : Array.from({ length: preferredStart }, (_, index) => preferredStart - index - 1)),
      ]
      outer: for (const ri of candidateStarts) {
        for (let si = 0; si < expectedSequence.length; si++) {
          if (result[ri + si] !== expectedSequence[si]) continue outer
        }
        seqStart = ri
        break
      }
    }

    if (seqStart < 0) return null

    const newLines: string[] = []
    let seqIdx = 0
    for (const entry of hunk.entries) {
      if (entry.type === 'context') {
        newLines.push(result[seqStart + seqIdx]!)
        seqIdx++
      } else if (entry.type === 'remove') {
        seqIdx++
      } else if (entry.type === 'add') {
        newLines.push(entry.text)
      }
    }

    result.splice(seqStart, expectedSequence.length, ...newLines)
    nextStart = seqStart + newLines.length
  }

  return result.join('\n')
}

async function applyTurnFileChanges(
  cwd: string,
  turnInfos: Map<string, CollectedTurnFileInfo>,
  allowedPatchIds?: Set<string>,
): Promise<{ applied: number; errors: string[]; appliedPatchIds: string[] }> {
  if (turnInfos.size === 0) return { applied: 0, errors: [], appliedPatchIds: [] }

  let applied = 0
  const errors: string[] = []
  const appliedPatchIds: string[] = []
  const allPatchInputs = [...turnInfos.values()]
    .flatMap((info) => info.patchInputs)
    .filter((patch) => !allowedPatchIds || allowedPatchIds.has(patch.callId))

  for (const patch of allPatchInputs) {
    let patchApplied = false
    let patchHadError = false
    const changes = parseApplyPatchInput(patch.input)
    const beforeApplied = applied
    let snapshot: Awaited<ReturnType<typeof capturePatchFiles>>
    try {
      snapshot = await capturePatchFiles(cwd, changes)
    } catch (error) {
      errors.push(`Could not capture patch ${patch.callId}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const change of changes) {
      const filePath = isAbsolute(change.path) ? change.path : join(cwd, change.path)
      const movedToPath = change.movedToPath
        ? (isAbsolute(change.movedToPath) ? change.movedToPath : join(cwd, change.movedToPath))
        : null

      try {
        if (change.operation === 'add') {
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(filePath, change.diff ? `${change.diff}\n` : '', 'utf8')
          applied++
          patchApplied = true
          continue
        }

        if (change.operation === 'delete') {
          await rm(filePath, { force: true })
          applied++
          patchApplied = true
          continue
        }

        let sourcePath = filePath
        if (movedToPath) {
          const sourceStat = await stat(sourcePath).catch(() => null)
          if (!sourceStat) {
            const movedStat = await stat(movedToPath).catch(() => null)
            if (movedStat) sourcePath = movedToPath
          }
        }

        const currentContent = await readFile(sourcePath, 'utf8')
        const newContent = applyV4aDiff(currentContent, change.diff)
        if (newContent === null) {
          patchHadError = true
          errors.push(`Could not apply patch for ${sourcePath}`)
          continue
        }

        if (movedToPath) {
          if (sourcePath === movedToPath) {
            if (newContent !== currentContent) {
              await writeFile(movedToPath, newContent, 'utf8')
            }
          } else {
            await mkdir(dirname(movedToPath), { recursive: true })
            await writeFile(movedToPath, newContent, 'utf8')
            await rm(filePath, { force: true })
          }
        } else if (newContent !== currentContent) {
          await writeFile(filePath, newContent, 'utf8')
        }
        applied++
        patchApplied = true
      } catch (err) {
        patchHadError = true
        errors.push(`Failed to apply patch for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (patchHadError) {
      const restoreErrors = await snapshot.restore()
      errors.push(...restoreErrors)
      if (restoreErrors.length === 0) applied = beforeApplied
    } else if (patchApplied) appliedPatchIds.push(patch.callId)
  }

  return { applied, errors, appliedPatchIds }
}

async function revertTurnFileChanges(
  cwd: string,
  turnInfos: Map<string, CollectedTurnFileInfo>,
  allowedPatchIds?: Set<string>,
): Promise<{ reverted: number; errors: string[]; revertedPatchIds: string[] }> {
  if (turnInfos.size === 0) return { reverted: 0, errors: [], revertedPatchIds: [] }

  let reverted = 0
  const errors: string[] = []
  const revertedPatchIds: string[] = []

  const allEntries = [...turnInfos.values()]
  const allPatchInputs = allEntries
    .flatMap((info) => info.patchInputs)
    .filter((patch) => !allowedPatchIds || allowedPatchIds.has(patch.callId))
    .reverse()
  const allCommandPaths = new Set(allowedPatchIds ? [] : allEntries.flatMap((info) => info.commandFilePaths))
  const patchHandledPaths = new Set(allPatchInputs.flatMap(patch => parseApplyPatchInput(patch.input))
    .flatMap(change => [change.path, ...(change.movedToPath ? [change.movedToPath] : [])])
    .map(path => isAbsolute(path) ? path : join(cwd, path)))

  let isGitRepo = false
  let gitRoot = ''
  try {
    gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], { cwd })
    isGitRepo = !!gitRoot
  } catch { /* not a git repo */ }

  const trackedFiles = new Set<string>()
  if (isGitRepo) {
    try {
      const tracked = await runCommandCapture('git', ['ls-files', '--full-name'], { cwd: gitRoot })
      for (const f of tracked.split('\n')) {
        if (f.trim()) trackedFiles.add(join(gitRoot, f.trim()))
      }
    } catch { /* empty */ }
  }

  const patchRevertedPaths = new Set<string>()

  for (const patch of allPatchInputs) {
    let patchReverted = false
    let patchHadError = false
    const changes = parseApplyPatchInput(patch.input)
    const beforeReverted = reverted
    const beforePaths = new Set(patchRevertedPaths)
    let snapshot: Awaited<ReturnType<typeof capturePatchFiles>>
    try {
      snapshot = await capturePatchFiles(cwd, changes)
    } catch (error) {
      errors.push(`Could not capture patch ${patch.callId}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (let ci = changes.length - 1; ci >= 0; ci--) {
      const change = changes[ci]!
      const filePath = isAbsolute(change.path) ? change.path : join(cwd, change.path)
      const movedToPath = change.movedToPath
        ? (isAbsolute(change.movedToPath) ? change.movedToPath : join(cwd, change.movedToPath))
        : null

      try {
        if (change.operation === 'add') {
          const fileStat = await stat(filePath).catch(() => null)
          if (fileStat) {
            await rm(filePath, { force: true })
            reverted++
            patchRevertedPaths.add(filePath)
            patchReverted = true
          }
        } else if (change.operation === 'update' && (change.diff || movedToPath)) {
          let reversed = false
          try {
            const sourcePath = movedToPath ?? filePath
            const currentContent = await readFile(sourcePath, 'utf8')
            const newContent = reverseV4aDiff(currentContent, change.diff)
            if (newContent !== null && newContent !== currentContent) {
              const { writeFile } = await import('node:fs/promises')
              if (movedToPath) {
                await mkdir(dirname(filePath), { recursive: true })
                await writeFile(filePath, newContent)
                await rm(movedToPath, { force: true })
              } else {
                await writeFile(filePath, newContent)
              }
              reverted++
              patchRevertedPaths.add(filePath)
              if (movedToPath) patchRevertedPaths.add(movedToPath)
              patchReverted = true
              reversed = true
            } else if (newContent !== null && movedToPath) {
              await mkdir(dirname(filePath), { recursive: true })
              await rename(movedToPath, filePath)
              reverted++
              patchRevertedPaths.add(filePath)
              patchRevertedPaths.add(movedToPath)
              patchReverted = true
              reversed = true
            }
          } catch { /* file read/write failed */ }

          if (!reversed) {
            const isTracked = trackedFiles.has(filePath)
            if (isTracked && isGitRepo) {
              const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
              try {
                await restoreHeadFile(gitRoot, relativePath, filePath)
                if (movedToPath) {
                  await rm(movedToPath, { force: true })
                }
                reverted++
                patchRevertedPaths.add(filePath)
                if (movedToPath) patchRevertedPaths.add(movedToPath)
                patchReverted = true
              } catch {
                patchHadError = true
                errors.push(`Could not revert: ${filePath}`)
              }
            } else {
              patchHadError = true
              errors.push(`Could not reverse patch for untracked file: ${filePath}`)
            }
          }
        } else if (change.operation === 'delete') {
          const isTracked = trackedFiles.has(filePath)
          if (isTracked && isGitRepo) {
            const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
            try {
              await restoreHeadFile(gitRoot, relativePath, filePath)
              reverted++
              patchRevertedPaths.add(filePath)
              patchReverted = true
            } catch {
              patchHadError = true
              errors.push(`Could not restore deleted file: ${filePath}`)
            }
          }
        }
      } catch (err) {
        patchHadError = true
        errors.push(`Failed to revert patch for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (patchHadError) {
      const restoreErrors = await snapshot.restore()
      errors.push(...restoreErrors)
      if (restoreErrors.length === 0) {
        reverted = beforeReverted
        patchRevertedPaths.clear()
        for (const path of beforePaths) patchRevertedPaths.add(path)
      }
    } else if (patchReverted) revertedPatchIds.push(patch.callId)
  }

  for (const filePath of allCommandPaths) {
    if (patchHandledPaths.has(filePath)) continue
    const isTracked = trackedFiles.has(filePath)
    if (isTracked && isGitRepo) {
      const relativePath = filePath.startsWith(gitRoot + '/') ? filePath.slice(gitRoot.length + 1) : filePath
      try {
        await restoreHeadFile(gitRoot, relativePath, filePath)
        reverted++
      } catch {
        errors.push(`Could not restore command-modified file: ${filePath}`)
      }
    }
  }

  return { reverted, errors, revertedPatchIds }
}

export function createThreadFileRollbackService({ history, rpc }: FileRollbackDependencies) {
  const operations = new Map<string, Promise<unknown>>()
  async function rollbackFilesUnlocked({ threadId, turnId, cwd, action, scope, patchIds }: FileRollbackInput) {
    // Check native history support before changing workspace files.
    if (scope === 'turn_and_later') await history.assertRollbackAllowed(threadId)
    const threadReadResult = await rpc('thread/read', { threadId, includeTurns: true })
    const record = asRecord(threadReadResult)
    const thread = asRecord(record?.thread)
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const sessionPath = readNonEmptyString(thread?.path)
    if (!sessionPath || !isAbsolute(sessionPath)) {
      return { reverted: 0, errors: [], message: 'No session log available' }
    }
    let foundTurnIndex = -1
    const turnIdsToRevert = new Set<string>()
    for (let i = 0; i < turns.length; i++) {
      const turnRecord = asRecord(turns[i])
      const id = readNonEmptyString(turnRecord?.id)
      if (id === turnId) {
        foundTurnIndex = i
      }
      if (foundTurnIndex >= 0 && id) {
        turnIdsToRevert.add(id)
        if (scope === 'single_turn') break
      }
    }
    if (turnIdsToRevert.size === 0) {
      return { reverted: 0, errors: [], message: 'No turns to revert' }
    }
    let sessionLogRaw: string
    try {
      sessionLogRaw = await readFile(sessionPath, 'utf8')
    } catch {
      return { reverted: 0, errors: ['Could not read session log'], message: 'Session log unreadable' }
    }
    const turnInfos = collectFileChangesForTurns(sessionLogRaw, turnIdsToRevert, cwd)
    if (turnInfos.size === 0) {
      return { changed: 0, errors: [], message: action === 'redo' ? 'No file changes to redo' : 'No file changes to revert' }
    }
    if (action === 'redo') {
      const result = await applyTurnFileChanges(cwd, turnInfos, patchIds)
      return { ...result, changed: result.applied, message: `Reapplied ${result.applied} file change(s)` }
    }
    const result = await revertTurnFileChanges(cwd, turnInfos, patchIds)
    return { ...result, changed: result.reverted, message: `Reverted ${result.reverted} file change(s)` }
  }
  async function rollbackFiles(input: FileRollbackInput) {
    const key = await realpath(input.cwd).catch(() => resolve(input.cwd))
    const previous = operations.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => rollbackFilesUnlocked(input))
    operations.set(key, operation)
    try {
      return await operation
    } finally {
      if (operations.get(key) === operation) operations.delete(key)
    }
  }
  return { rollbackFiles }
}
