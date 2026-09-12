import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { buildComposerCommands, commandKeyAction, filterComposerCommands, findSlashToken } from './composerCommands'
import { useComposerCommandPicker } from '../../composables/useComposerCommandPicker'

const event = (key: string, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 0, preventDefault() {}, ...extra }) as KeyboardEvent
describe('slash command input contract', () => {
  it.each(['https://a/b', '/tmp/path', '2026/09/06', './a/b', '../a/b', '` /plan', '```ts\n /plan', '/plan/extra'])('leaves code and literal paths alone: %s', (text) => {
    expect(findSlashToken(text, text.length)).toBeNull()
  })
  it('detects a token at the cursor without consuming neighboring text', () => {
    expect(findSlashToken('/plan 后文', 5)).toBeNull()
    expect(findSlashToken('/plan', 3, 4)).toBeNull()
    expect(findSlashToken('/plan', 3)?.end).toBe(5)
  })
  it('keeps normal Enter behavior even for an exact command', () => {
    expect(commandKeyAction(event('Enter'), 1, -1)).toBeNull()
    expect(commandKeyAction(event('Enter'), 1, 0)).toBe('select')
    for (const flags of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(commandKeyAction(event('Enter', flags), 1, 0)).toBeNull()
    }
    expect(commandKeyAction(event('ArrowDown'), 0, -1)).toBeNull()
    expect(commandKeyAction(event('Tab'), 1, 0)).toBeNull()
  })
  it('supports Chinese descriptions, prompts and distinct skills with duplicate names', () => {
    const commands = buildComposerCommands([{ name: 'review', description: '审查代码', path: '/a' }, { name: 'review', path: '/b' }], [{ name: 'weekly', path: '/p' }])
    expect(filterComposerCommands(commands, '计划').map((row) => row.name)).toEqual(['/plan'])
    expect(filterComposerCommands(commands, 'review')).toHaveLength(3)
    expect(filterComposerCommands(commands, 'prompts:weekly')[0]?.value).toBe('/p')
  })
  it('resets selection on edits, wraps arrows, and never reopens a dismissed token while typing', () => {
    const applied: string[] = []
    const picker = useComposerCommandPicker(ref(buildComposerCommands([], [])), (command) => applied.push(command.name))
    picker.update('/', 1)
    expect(picker.selectedIndex.value).toBe(-1)
    expect(picker.keydown(event('Enter'))).toBe(false)
    picker.keydown(event('ArrowUp')); expect(picker.selectedIndex.value).toBe(picker.results.value.length - 1)
    picker.keydown(event('ArrowDown')); expect(picker.selectedIndex.value).toBe(0)
    picker.update('/plan', 5); expect(picker.selectedIndex.value).toBe(-1)
    picker.keydown(event('ArrowDown')); picker.keydown(event('Enter')); expect(applied).toEqual(['/plan'])
    picker.update('/planmore', 9); expect(picker.visible.value).toBe(false)
    picker.update('', 0); picker.update('/', 1); expect(picker.visible.value).toBe(true)
    picker.keydown(event('Escape')); picker.update('/model', 6); expect(picker.visible.value).toBe(false)
  })
  it('does not open on paste or a subsequent token, but allows a fresh draft', () => {
    const picker = useComposerCommandPicker(ref(buildComposerCommands([], [])), () => {})
    picker.update('/plan', 5, 5, true); expect(picker.visible.value).toBe(false)
    picker.update('/plan ', 6); picker.update('/plan /', 7); expect(picker.visible.value).toBe(false)
    picker.update('', 0); picker.update('/', 1); expect(picker.visible.value).toBe(true)
  })
})

it('only starts a command-input session from a slash typed into an empty draft', () => {
  const picker = useComposerCommandPicker(ref(buildComposerCommands([], [])), () => {})
  picker.update('/existing', 1, 1, false, false)
  expect(picker.visible.value).toBe(false)
  picker.update('', 0, 0, false, false)
  picker.update('/', 1, 1, false, true)
  picker.update('/plan', 5, 5, false, false)
  expect(picker.visible.value).toBe(true)
  picker.update('/plan body', 5, 5, false, false)
  expect(picker.visible.value).toBe(false)
  picker.update('/plan', 5, 5, false, false)
  expect(picker.visible.value).toBe(false)
})


it('searches translated built-in descriptions while preserving external descriptions', () => {
  const translate = (message: string) => message === '切换到计划模式，先讨论实施方案' ? 'Discuss implementation in Plan mode' : message === '保存' ? 'Save' : message
  const commands = buildComposerCommands([{ name: 'external', path: '/a', description: '保存' }], [], translate)
  expect(filterComposerCommands(commands, 'discuss').map(row => row.name)).toEqual(['/plan'])
  expect(filterComposerCommands(commands, '计划').map(row => row.name)).toEqual(['/plan'])
  expect(commands.find(row => row.name === '/external')?.description).toBe('保存')
})


it.each(['已有内容', 'hello', '第一行\n第二行', '先讨论，', ' ', '\n', '/plan '])('keeps slash literal after preceding content: %s', prefix => {
  const picker = useComposerCommandPicker(ref(buildComposerCommands([], [])), () => {})
  picker.update(prefix + '/', prefix.length + 1)
  expect(picker.visible.value).toBe(false)
  picker.update(prefix + '/plan', prefix.length + 5)
  expect(picker.visible.value).toBe(false)
  expect(picker.token.value).toBeNull()
})
