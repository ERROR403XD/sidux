import { computed, createRenderer, nextTick, reactive, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComposerDraftPersistence } from './useComposerDraftPersistence'

const renderer = createRenderer<any, any>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
  setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {},
})
type Payload = { text: string; images: string[]; files: { path: string }[]; skills: string[] }
const payload = (text: string): Payload => ({ text, images: [], files: [], skills: [] })
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.unstubAllGlobals() })

function fixture(recovery?: Map<string, string>) {
  const lifecycle = new EventTarget()
  vi.stubGlobal('window', lifecycle)
  const stored = new Map<string, Payload>([['a', payload('A')], ['b', payload('B')], ['b:edit', payload('B edit')]])
  const context = reactive({ thread: 'a', edit: '' })
  const current = ref(payload(''))
  const save = vi.fn((key: string, value: Payload) => { stored.set(key, structuredClone(value)); return true })
  const load = vi.fn((key: string) => structuredClone(stored.get(key) ?? null))
  const app = renderer.createApp({ setup() {
    useComposerDraftPersistence({
      recovery,
      context: computed(() => context.edit || context.thread),
      payload: () => ({ ...current.value, images: [...current.value.images], files: current.value.files.map(row => ({ ...row })), skills: [...current.value.skills] }),
      load, save, restore: value => { current.value = value ?? payload('') },
    })
    return () => null
  } })
  app.mount({})
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); mounted = false } }
  cleanups.push(unmount)
  return { lifecycle, stored, context, current, save, load, unmount }
}

describe('composer draft ownership and persistence', () => {
  it('does not overwrite another tab when leaving an unchanged draft', async () => {
    const test = fixture()
    test.stored.set('a', payload('newer A from another tab'))
    test.context.thread = 'b'
    await nextTick()
    expect(test.stored.get('a')?.text).toBe('newer A from another tab')
    expect(test.current.value.text).toBe('B')
    test.context.thread = 'a'
    await nextTick()
    expect(test.current.value.text).toBe('newer A from another tab')
    test.unmount()
    expect(test.save).not.toHaveBeenCalled()
  })
  it('saves a last-keystroke change to the original conversation before switching', async () => {
    const test = fixture()
    test.current.value.text = 'A final keystroke'
    test.context.thread = 'b'
    await nextTick()
    expect(test.stored.get('a')?.text).toBe('A final keystroke')
    expect(test.stored.get('b')?.text).toBe('B')
    expect(test.current.value.text).toBe('B')
    expect(test.save).toHaveBeenCalledTimes(1)
  })
  it('batches thread and queue-edit identity changes without touching the intermediate base draft', async () => {
    const test = fixture()
    test.context.thread = 'b'
    test.context.edit = 'b:edit'
    await nextTick()
    expect(test.current.value.text).toBe('B edit')
    expect(test.load.mock.calls.map(([key]) => key)).toEqual(['a', 'b:edit'])
    test.current.value.text = 'B edited'
    test.context.edit = ''
    await nextTick()
    expect(test.stored.get('b:edit')?.text).toBe('B edited')
    expect(test.current.value.text).toBe('B')
    expect(test.stored.get('b')?.text).toBe('B')
  })
  it('flushes pending changes on unmount and does not revive the lifecycle listener', async () => {
    const test = fixture()
    test.current.value.text = 'pending at unmount'
    test.unmount()
    await nextTick()
    expect(test.stored.get('a')?.text).toBe('pending at unmount')
    test.lifecycle.dispatchEvent(new Event('pagehide'))
    expect(test.save).toHaveBeenCalledTimes(1)
  })
  it('flushes pagehide before the queued watcher runs, exactly once', async () => {
    const test = fixture()
    test.current.value.text = 'pending at reload'
    test.lifecycle.dispatchEvent(new Event('pagehide'))
    expect(test.stored.get('a')?.text).toBe('pending at reload')
    await nextTick()
    test.lifecycle.dispatchEvent(new Event('pagehide'))
    expect(test.save).toHaveBeenCalledTimes(1)
  })
  it('batches text and attachment updates and preserves their per-context ownership', async () => {
    const test = fixture()
    test.current.value.text = 'A text'
    test.current.value.images.push('/uploads/a.png')
    test.current.value.files.push({ path: '/workspace/a.txt' })
    test.current.value.skills.push('/skills/a')
    await nextTick()
    expect(test.save).toHaveBeenCalledTimes(1)
    test.context.thread = 'b'
    await nextTick()
    test.context.thread = 'a'
    await nextTick()
    expect(test.current.value).toEqual({ text: 'A text', images: ['/uploads/a.png'], files: [{ path: '/workspace/a.txt' }], skills: ['/skills/a'] })
    expect(test.save).toHaveBeenCalledTimes(1)
  })
  it('retries failed storage writes on exit and retains the input until leaving', async () => {
    const test = fixture()
    test.save.mockReturnValueOnce(false)
    test.current.value.text = 'not yet saved'
    await nextTick()
    expect(test.current.value.text).toBe('not yet saved')
    expect(test.stored.get('a')?.text).toBe('A')
    test.context.thread = 'b'
    await nextTick()
    expect(test.stored.get('a')?.text).toBe('not yet saved')
    expect(test.save).toHaveBeenCalledTimes(2)
  })
  it('keeps a failed draft in memory across conversation switches until storage recovers', async () => {
    const test = fixture()
    test.save.mockReturnValue(false)
    test.current.value.text = 'A not on disk'
    await nextTick()
    test.context.thread = 'b'
    await nextTick()
    test.context.thread = 'a'
    await nextTick()
    expect(test.current.value.text).toBe('A not on disk')
    test.save.mockImplementation((key, value) => { test.stored.set(key, value); return true })
    test.lifecycle.dispatchEvent(new Event('pagehide'))
    expect(test.stored.get('a')?.text).toBe('A not on disk')
  })

  it('recovers failed writes after the composer remounts on the same page', async () => {
    const recovery = new Map<string, string>()
    const first = fixture(recovery)
    first.save.mockReturnValue(false)
    first.current.value.text = 'kept through remount'
    first.unmount()
    const remounted = fixture(recovery)
    expect(remounted.current.value.text).toBe('kept through remount')
    remounted.lifecycle.dispatchEvent(new Event('pagehide'))
    expect(remounted.stored.get('a')?.text).toBe('kept through remount')
    expect(recovery.size).toBe(0)
  })

  it('persists an intentional clear but never writes an anonymous draft', async () => {
    const test = fixture()
    test.current.value = payload('')
    await nextTick()
    expect(test.stored.get('a')?.text).toBe('')
    test.context.thread = ''
    await nextTick()
    test.current.value.text = 'no owner'
    await nextTick()
    test.unmount()
    expect(test.stored.has('')).toBe(false)
    expect(test.save).toHaveBeenCalledTimes(1)
  })
})
