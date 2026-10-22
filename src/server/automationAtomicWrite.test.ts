import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const renameBehavior = vi.hoisted(() => ({ failuresLeft: 0, code: 'EPERM' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (renameBehavior.failuresLeft > 0) {
        renameBehavior.failuresLeft -= 1
        throw Object.assign(new Error(`fixture rename ${renameBehavior.code}`), { code: renameBehavior.code })
      }
      return actual.rename(from, to)
    }),
  }
})

import { writeAutomationFileAtomic } from './automationDefinition.js'

beforeEach(async () => {
  const { rename } = await import('node:fs/promises')
  vi.mocked(rename).mockClear()
})

afterEach(async () => {
  renameBehavior.failuresLeft = 0
  renameBehavior.code = 'EPERM'
})

it.each(['EPERM', 'EBUSY', 'EACCES'])('retries transient %s locks and cleans the random temporary file', async code => {
  const home = await mkdtemp(join(tmpdir(), 'automation-atomic-'))
  const target = join(home, 'state.json')
  try {
    renameBehavior.code = code
    renameBehavior.failuresLeft = 2
    await writeAutomationFileAtomic(target, '{"attempt":3}')
    expect(await readFile(target, 'utf8')).toBe('{"attempt":3}')
    expect(await readdir(home)).toEqual(['state.json'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

it.each(['EPERM', 'EBUSY', 'EACCES'])('bounds persistent %s retries and preserves the existing destination', async code => {
  const home = await mkdtemp(join(tmpdir(), 'automation-atomic-'))
  const target = join(home, 'state.json')
  try {
    await writeAutomationFileAtomic(target, 'original')
    renameBehavior.code = code
    renameBehavior.failuresLeft = 100
    await expect(writeAutomationFileAtomic(target, '{}')).rejects.toMatchObject({ code })
    expect(await readFile(target, 'utf8')).toBe('original')
    expect(await readdir(home)).toEqual(['state.json'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('fails immediately on non-transient rename errors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'automation-atomic-'))
  const target = join(home, 'state.json')
  try {
    renameBehavior.code = 'ENOENT'
    renameBehavior.failuresLeft = 100
    await expect(writeAutomationFileAtomic(target, '{}')).rejects.toMatchObject({ code: 'ENOENT' })
    const { rename } = await import('node:fs/promises')
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1)
  } finally { await rm(home, { recursive: true, force: true }) }
})
