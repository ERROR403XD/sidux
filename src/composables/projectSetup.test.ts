import { expect, it } from 'vitest'
import { projectDisplayName, projectSetupInput } from './projectSetup'

it('keeps display labels including slashes separate from the exact target directory', () => {
  expect(projectSetupInput('/tmp/my-bot', ' 我的 / 机器人 ')).toEqual({ path: '/tmp/my-bot', options: { createIfMissing: true, label: '我的 / 机器人' } })
  expect(() => projectSetupInput('/tmp/ok', '  ')).toThrow('project name')
  expect(() => projectSetupInput('relative/path', 'name')).toThrow('absolute')
  expect(() => projectSetupInput('', 'name')).toThrow('absolute')
})
it('reuses saved labels or the selected directory name', () => {
  expect(projectDisplayName('/tmp/bot', { '/tmp/bot': '已有名称' })).toBe('已有名称')
  expect(projectDisplayName('/tmp/bot/', {})).toBe('bot')
  expect(projectDisplayName('', {})).toBe('')
})
