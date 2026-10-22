import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { VirtualProjectStore } from './virtualProjects'
import { isVirtualProjectId } from '../projectOrganization'
import { readProjectArchiveMembers } from './projectOrganizationArchive'

const roots: string[] = []
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'project-organization-'))
  roots.push(home)
  return { home, store: new VirtualProjectStore(home) }
}
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })

it('creates, renames and removes only CodexApp metadata, retaining the original directories and account state', async () => {
  const { home, store } = await fixture()
  await writeFile(join(home, 'auth.json'), 'fixture credential unchanged')
  const first = await store.save(undefined, ' 项目 / 中文 <> ')
  const sameName = await store.save(undefined, first.label)
  expect(isVirtualProjectId(first.id)).toBe(true)
  expect(sameName.id).not.toBe(first.id)
  expect((await readdir(home)).sort()).toEqual(['auth.json', 'codexapp-projects.json'])
  const cwd = '/somewhere/Documents/Codex/2026-09-13/original-conversation'
  await store.assign(cwd, first.id)
  await store.save(first.id, 'Renamed')
  expect(await new VirtualProjectStore(home).get(first.id)).toEqual({ id: first.id, label: 'Renamed', cwds: [cwd] })
  await store.remove(first.id)
  expect(await store.list()).toEqual([sameName])
  expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('fixture credential unchanged')
  expect((await readdir(home)).sort()).toEqual(['auth.json', 'codexapp-projects.json'])
})

it('serializes concurrent changes, moves membership once and permits returning a conversation to the ungrouped list', async () => {
  const { store } = await fixture()
  const projects = await Promise.all(Array.from({ length: 12 }, (_, index) => store.save(undefined, `project-${index}`)))
  const cwd = '/fixture/Documents/Codex/2026-09-13/session'
  await Promise.all(projects.map(project => store.assign(cwd, project.id)))
  expect((await store.list()).filter(project => project.cwds.includes(cwd)).map(project => project.id)).toEqual([projects.at(-1)!.id])
  await store.assign(cwd, null)
  expect((await store.list()).flatMap(project => project.cwds)).toEqual([])
})

it('rejects accidental real-project binding and leaves saved membership intact on invalid edits or corrupted metadata', async () => {
  const { store } = await fixture()
  const project = await store.save(undefined, 'Keep')
  await expect(store.assign('/real/project', project.id)).rejects.toThrow('directory')
  await expect(store.assign('/fixture/Documents/Codex/2026-09-13/chat', 'missing')).rejects.toThrow('not found')
  await expect(store.save(project.id, '')).rejects.toThrow('name')
  expect(await store.get(project.id)).toEqual(project)
  await writeFile(store.path, '{broken')
  await expect(store.save(undefined, 'Other')).rejects.toThrow()
  expect(await readFile(store.path, 'utf8')).toBe('{broken')
})

it('keeps legacy directory ZIPs compatible and validates organized project archives before importing', () => {
  expect(readProjectArchiveMembers(undefined)).toBeNull()
  expect(readProjectArchiveMembers({ version: 1, members: [] })).toEqual([])
  const member = { cwd: '/fixture/Documents/Codex/2026-09-13/chat', prefix: 'files/000001/' }
  expect(readProjectArchiveMembers({ version: 1, members: [member] })).toEqual([member])
  for (const members of [[member, member], [{ ...member, cwd: '/real/project' }], [{ ...member, prefix: '../' }]]) {
    expect(() => readProjectArchiveMembers({ version: 1, members })).toThrow('archive')
  }
})

it('keeps automation membership optional across removal without weakening ordinary edits or masking corrupt state', async () => {
  const { store } = await fixture()
  const project = await store.save(undefined, 'Existing')
  const other = await store.save(undefined, 'Other')
  const cwd = '/fixture/Documents/Codex/2026-09-13/automation'
  await store.assignIfPresent(cwd, project.id)
  expect((await store.get(project.id)).cwds).toEqual([cwd])
  await store.assign(cwd, other.id)
  await Promise.all([store.remove(project.id), store.assignIfPresent(cwd, project.id)])
  expect(await store.list()).toEqual([{ ...other, cwds: [cwd] }])
  await expect(store.assign(cwd, project.id)).rejects.toThrow('not found')
  await expect(store.assignIfPresent('/real/project', project.id)).rejects.toThrow('directory')
  await writeFile(store.path, '{broken')
  await expect(store.assignIfPresent(cwd, project.id)).rejects.toThrow()
  expect(await readFile(store.path, 'utf8')).toBe('{broken')
})
