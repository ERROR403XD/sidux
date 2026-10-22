import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { writeAutomationFileAtomic } from './automationDefinition.js'

const mutationsByPath = new Map<string, Promise<void>>()

export async function readGlobalState(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// Callers submit the whole read-modify-write operation; internal writers never enqueue again.
export function queueGlobalStateMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const key = resolve(path)
  const run = (mutationsByPath.get(key) ?? Promise.resolve()).then(mutation)
  const settled = run.then(() => undefined, () => undefined)
  mutationsByPath.set(key, settled)
  void settled.then(() => {
    if (mutationsByPath.get(key) === settled) mutationsByPath.delete(key)
  })
  return run
}

export async function writeGlobalState(path: string, payload: Record<string, unknown>): Promise<void> {
  await writeAutomationFileAtomic(path, JSON.stringify(payload))
}
