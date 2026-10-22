import type { Stats } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { asRecord } from './httpUtils.js'

type LocalDirectoryDependencies = {
  isAbsolute: (path: string) => boolean
  mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>
  resolve: (path: string) => string
  stat: (path: string) => Promise<Stats>
}
type LocalDirectoryResult = { status: 200; path: string } | { status: 400; error: string }

export function createLocalDirectoryService(dependencies: LocalDirectoryDependencies = { isAbsolute, mkdir, resolve, stat }) {
  const { isAbsolute, mkdir, resolve, stat } = dependencies
  return {
    async ensureDirectory(input: unknown): Promise<LocalDirectoryResult> {
      const payload = asRecord(input)
      const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
      if (!rawPath) return { status: 400, error: 'Missing path' }
      const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
      try {
        const info = await stat(normalizedPath)
        if (!info.isDirectory()) return { status: 400, error: 'Path exists but is not a directory' }
      } catch {
        await mkdir(normalizedPath, { recursive: true })
      }
      return { status: 200, path: normalizedPath }
    },
  }
}
