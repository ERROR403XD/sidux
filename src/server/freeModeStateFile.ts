import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FreeModeState } from './freeMode.js'

export async function writeFreeModeStateFile(statePath: string, state: FreeModeState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
}
