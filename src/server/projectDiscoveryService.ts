import { spawn } from 'node:child_process'
import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { resolveRipgrepCommand } from '../commandResolution.js'
import { asRecord, getErrorMessage } from './httpUtils.js'

type DiscoveryResult<T> = { status: 200; data: T } | { status: 400 | 404 | 500; error: string }
type ProjectDiscoveryDependencies = {
  isAbsolute: (path: string) => boolean
  join: (...paths: string[]) => string
  listFiles: (cwd: string) => Promise<string[]>
  resolve: (path: string) => string
  scoreFileCandidate: (path: string, query: string) => number
  stat: (path: string) => Promise<Stats>
}

export function createProjectDiscoveryService(dependencies: ProjectDiscoveryDependencies = {
  isAbsolute, join, listFiles: listFilesWithRipgrep, resolve, scoreFileCandidate, stat,
}) {
  const { isAbsolute, join, listFiles, resolve, scoreFileCandidate, stat } = dependencies

  return {
    async suggestRoot(basePath: string): Promise<DiscoveryResult<{ name: string; path: string }>> {
      if (!basePath) return { status: 400, error: 'Missing basePath' }
      const normalizedBasePath = isAbsolute(basePath) ? basePath : resolve(basePath)
      try {
        const baseInfo = await stat(normalizedBasePath)
        if (!baseInfo.isDirectory()) return { status: 400, error: 'basePath is not a directory' }
      } catch {
        return { status: 404, error: 'basePath does not exist' }
      }

      let index = 1
      while (index < 100000) {
        const candidateName = `New Project (${String(index)})`
        const candidatePath = join(normalizedBasePath, candidateName)
        try {
          await stat(candidatePath)
          index += 1
          continue
        } catch {
          return { status: 200, data: { name: candidateName, path: candidatePath } }
        }
      }
      return { status: 500, error: 'Failed to compute project name suggestion' }
    },

    async searchFiles(input: unknown): Promise<DiscoveryResult<{ path: string }[]>> {
      const payload = asRecord(input)
      const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
      const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
      const limitRaw = typeof payload?.limit === 'number' ? payload.limit : 20
      const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))
      if (!rawCwd) return { status: 400, error: 'Missing cwd' }
      const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(rawCwd)
      try {
        const info = await stat(cwd)
        if (!info.isDirectory()) return { status: 400, error: 'cwd is not a directory' }
      } catch {
        return { status: 404, error: 'cwd does not exist' }
      }

      try {
        const files = await listFiles(cwd)
        const scored = files
          .map(path => ({ path, score: scoreFileCandidate(path, query) }))
          .filter(row => query.length === 0 || row.score < 10)
          .sort((first, second) => (first.score - second.score) || first.path.localeCompare(second.path))
          .slice(0, limit)
          .map(row => ({ path: row.path }))
        return { status: 200, data: scored }
      } catch (error) {
        return { status: 500, error: getErrorMessage(error, 'Failed to search files') }
      }
    },
  }
}

function scoreFileCandidate(path: string, query: string): number {
  if (!query) return 0
  const lowerPath = path.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const baseName = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
  if (baseName === lowerQuery) return 0
  if (baseName.startsWith(lowerQuery)) return 1
  if (baseName.includes(lowerQuery)) return 2
  if (lowerPath.includes(`/${lowerQuery}`)) return 3
  if (lowerPath.includes(lowerQuery)) return 4
  return 10
}

async function listFilesWithRipgrep(cwd: string): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const ripgrepCommand = resolveRipgrepCommand()
    if (!ripgrepCommand) {
      reject(new Error('ripgrep (rg) is not available'))
      return
    }

    const proc = spawn(ripgrepCommand, ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        const rows = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(rows)
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      reject(new Error(details || 'rg --files failed'))
    })
  })
}
