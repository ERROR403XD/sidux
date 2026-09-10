import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readProjectDirectories, saveProjectDirectories, updateProjectDirectoryBlock } from './projectDirectories'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('preserves existing instructions and updates only the managed block, including spaces and Chinese paths', async () => {
  const root = await mkdtemp(join(tmpdir(), '项目 目录-'))
  roots.push(root)
  const other = await mkdtemp(join(tmpdir(), '附加 目录-'))
  roots.push(other)
  const target = join(root, 'AGENTS.md')
  const original = '# 原有约定\n\n不修改生产服务。\n'
  await writeFile(target, original)
  await saveProjectDirectories(root, [other, other, root])
  expect(await readProjectDirectories(root)).toEqual([other])
  const saved = await readFile(target, 'utf8')
  expect(saved.startsWith(original)).toBe(true)
  await writeFile(target, saved + '\n## 后续规则\n保留此段。\n')
  await saveProjectDirectories(root, [])
  expect(await readProjectDirectories(root)).toEqual([])
  expect(await readFile(target, 'utf8')).toContain('## 后续规则\n保留此段。')
  await expect(saveProjectDirectories(root, ['/not-existing-0216'])).rejects.toThrow()
  await expect(saveProjectDirectories(root, ['relative'])).rejects.toThrow('绝对路径')
})
it('rejects broken blocks and linked global instructions without overwriting them', async () => {
  expect(() => updateProjectDirectoryBlock('<!-- codexapp:work-directories:start -->', [])).toThrow()
  const root = await mkdtemp(join(tmpdir(), 'project-links-'))
  roots.push(root)
  const source = join(root, 'global.md')
  await writeFile(source, 'global rules')
  await symlink(source, join(root, 'AGENTS.md'))
  await expect(saveProjectDirectories(root, [])).rejects.toThrow('符号链接')
  expect(await readFile(source, 'utf8')).toBe('global rules')
})
