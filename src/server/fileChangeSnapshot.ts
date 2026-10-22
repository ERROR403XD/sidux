import { chmod, lstat, mkdir, readFile, readlink, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type FileState =
  | { kind: 'missing' }
  | { kind: 'file'; content: Buffer; mode: number }
  | { kind: 'link'; target: string }

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

// A patch ID is the retry unit. Capture its files before any mutation so a
// failure cannot strand successful members outside the next Undo/Redo attempt.
export async function captureFileChangeSnapshot(paths: string[]) {
  const states = new Map<string, FileState>()
  const missingParents = new Set<string>()
  async function capture(path: string): Promise<void> {
    if (states.has(path)) return
    const info = await lstat(path).catch(error => {
      if (isMissing(error)) return null
      throw error
    })
    if (!info) {
      states.set(path, { kind: 'missing' })
      let parent = dirname(path)
      while (parent !== dirname(parent)) {
        const exists = await lstat(parent).catch(error => {
          if (isMissing(error)) return null
          throw error
        })
        if (exists) break
        missingParents.add(parent)
        parent = dirname(parent)
      }
    } else if (info.isSymbolicLink()) {
      states.set(path, { kind: 'link', target: await readlink(path) })
      const target = await realpath(path).catch(error => {
        if (isMissing(error)) return null
        throw error
      })
      if (target) await capture(target)
    } else if (info.isFile()) {
      states.set(path, { kind: 'file', content: await readFile(path), mode: info.mode & 0o7777 })
    } else {
      throw new Error(`File change target is not a file: ${path}`)
    }
  }
  for (const path of new Set(paths)) await capture(path)

  return {
    async restore(): Promise<string[]> {
      const errors: string[] = []
      // Restore regular targets before links, including targets written through a symlink.
      const ordered = [...states].sort(([, a], [, b]) => Number(a.kind === 'link') - Number(b.kind === 'link'))
      for (const [path, state] of ordered) {
        try {
          const current = await lstat(path).catch(error => {
            if (isMissing(error)) return null
            throw error
          })
          if (state.kind === 'missing') {
            if (current) await rm(path, { force: true })
          } else if (state.kind === 'link') {
            if (current?.isSymbolicLink() && await readlink(path) === state.target) continue
            if (current) await rm(path, { force: true })
            await mkdir(dirname(path), { recursive: true })
            await symlink(state.target, path)
          } else {
            if (current?.isFile() && (await readFile(path)).equals(state.content) && (current.mode & 0o7777) === state.mode) continue
            if (current && !current.isFile()) await rm(path, { force: true })
            await mkdir(dirname(path), { recursive: true })
            await writeFile(path, state.content)
            await chmod(path, state.mode)
          }
        } catch (error) {
          errors.push(`Failed to restore patch member ${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const parent of [...missingParents].sort((a, b) => b.length - a.length)) {
        await rmdir(parent).catch(error => {
          if (!isMissing(error) && !['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            errors.push(`Failed to remove patch directory ${parent}: ${error instanceof Error ? error.message : String(error)}`)
          }
        })
      }
      return errors
    },
  }
}
