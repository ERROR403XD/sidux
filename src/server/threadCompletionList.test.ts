import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ThreadCompletionList } from './threadCompletionList'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('starts empty, persists across terminals/restarts and acknowledges only the observed completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completions-'))
  roots.push(root)
  const events: unknown[] = []
  const path = join(root, 'state.json')
  const list = new ThreadCompletionList(path, (id, token) => events.push([id, token]))
  expect(await list.read()).toEqual({})
  await list.complete('thread', 'turn-1')
  await list.complete('thread', 'turn-2')
  await list.acknowledge('thread', 'turn-1')
  expect(await list.read()).toEqual({ thread: 'turn-2' })
  const restarted = new ThreadCompletionList(path)
  expect(await restarted.read()).toEqual({ thread: 'turn-2' })
  await restarted.acknowledge('thread', 'turn-2')
  await restarted.complete('thread', 'turn-2')
  expect(await restarted.read()).toEqual({})
  expect(await new ThreadCompletionList(path).read()).toEqual({})
  expect(events).toEqual([['thread', 'turn-1'], ['thread', 'turn-2']])
})
it('serializes simultaneous completions and clicks without dropping another thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'completions-'))
  roots.push(root)
  const list = new ThreadCompletionList(join(root, 'state.json'))
  await Promise.all([list.complete('one', 't1'), list.complete('two', 't2'), list.acknowledge('one', 't1')])
  expect(await list.read()).toEqual({ two: 't2' })
})
