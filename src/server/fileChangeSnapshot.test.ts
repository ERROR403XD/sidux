import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { captureFileChangeSnapshot } from './fileChangeSnapshot.js'

let fixture: string
beforeEach(async () => { fixture = await mkdtemp(join(tmpdir(), 'sidux-patch-snapshot-')) })
afterEach(async () => { await rm(fixture, { recursive: true, force: true }) })

it('restores exact file bytes and modes while retaining unrelated contents in a newly created directory', async () => {
  const existing = join(fixture, 'existing')
  const added = join(fixture, 'nested', 'added')
  await writeFile(existing, Buffer.from([0, 255, 10]))
  await chmod(existing, 0o751)
  const snapshot = await captureFileChangeSnapshot([existing, added])
  await writeFile(existing, 'modified')
  await chmod(existing, 0o600)
  await mkdir(join(fixture, 'nested'))
  await writeFile(added, 'added')
  await writeFile(join(fixture, 'nested', 'unrelated'), 'preserve')
  expect(await snapshot.restore()).toEqual([])
  expect(await readFile(existing)).toEqual(Buffer.from([0, 255, 10]))
  expect((await stat(existing)).mode & 0o777).toBe(0o751)
  await expect(stat(added)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(fixture, 'nested', 'unrelated'), 'utf8')).toBe('preserve')
})

it('reports a failed compensation without removing the obstructing directory or its data', async () => {
  const existing = join(fixture, 'existing')
  await writeFile(existing, 'before')
  const snapshot = await captureFileChangeSnapshot([existing])
  await rm(existing)
  await mkdir(existing)
  await writeFile(join(existing, 'unrelated'), 'preserve')
  const errors = await snapshot.restore()
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain('Failed to restore patch member')
  expect(await readFile(join(existing, 'unrelated'), 'utf8')).toBe('preserve')
})
