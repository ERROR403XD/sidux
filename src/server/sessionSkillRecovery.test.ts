import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mergeSessionSkillInputsIntoThreadResult,
  mergeSessionSkillInputsIntoTurns,
  readCachedSessionSkillInputsByTurn,
} from './sessionSkillRecovery.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('session skill recovery', () => {
  it('merges recovered skills into the last user message without duplicating paths', () => {
    const turns = [{
      id: 'turn-1',
      items: [
        { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: 'first' }] },
        { id: 'item-2', type: 'assistantMessage', content: [{ type: 'text', text: 'reply' }] },
        {
          id: 'item-3',
          type: 'userMessage',
          content: [
            { type: 'text', text: 'second' },
            { type: 'skill', name: 'existing', path: '/skills/existing/SKILL.md' },
          ],
        },
      ],
    }]
    const sessionLog = [
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<skill><name>existing</name><path>/skills/existing/SKILL.md</path></skill>' },
            { type: 'input_text', text: '<skill><name>browser</name><path>/skills/browser/SKILL.md</path></skill>' },
          ],
        },
      }),
    ].join('\n')

    const merged = mergeSessionSkillInputsIntoTurns(turns, sessionLog) as typeof turns

    expect(merged[0].items[2].content).toEqual([
      { type: 'text', text: 'second' },
      { type: 'skill', name: 'existing', path: '/skills/existing/SKILL.md' },
      { type: 'skill', name: 'browser', path: '/skills/browser/SKILL.md' },
    ])
  })

  it('retains turn context across appends, completes partial lines, and resets on rewrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-skill-recovery-'))
    roots.push(root)
    const path = join(root, 'session.jsonl')
    const start = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old' } })}\n`
    const skill = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<skill><name>fixture</name><path>/fixture/SKILL.md</path></skill>' }],
      },
    })

    await writeFile(path, start)
    expect((await readCachedSessionSkillInputsByTurn(path)).size).toBe(0)
    await appendFile(path, skill.slice(0, 30))
    expect((await readCachedSessionSkillInputsByTurn(path)).size).toBe(0)
    await appendFile(path, `${skill.slice(30)}\n`)
    expect((await readCachedSessionSkillInputsByTurn(path)).get('old')).toEqual([
      { name: 'fixture', path: '/fixture/SKILL.md' },
    ])

    await writeFile(path, start.replace('old', 'new') + skill + '\n')
    const rewritten = await readCachedSessionSkillInputsByTurn(path)
    expect(rewritten.has('old')).toBe(false)
    expect(rewritten.has('new')).toBe(true)
  })

  it('merges cached session data into a thread result and fails closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-skill-recovery-thread-'))
    roots.push(root)
    const sessionPath = join(root, 'session.jsonl')
    await writeFile(sessionPath, `${JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn-1' } })}\n${
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<skill><name>fixture</name><path>/fixture/SKILL.md</path></skill>' }],
        },
      })
    }\n`)
    const result = {
      thread: {
        id: 'thread-1',
        path: sessionPath,
        turns: [{ id: 'turn-1', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'message' }] }] }],
      },
    }

    const merged = await mergeSessionSkillInputsIntoThreadResult(result) as typeof result

    expect(merged.thread.turns[0].items[0].content).toEqual([
      { type: 'text', text: 'message' },
      { type: 'skill', name: 'fixture', path: '/fixture/SKILL.md' },
    ])

    const invalid = await mergeSessionSkillInputsIntoThreadResult({
      thread: { id: 'thread-1', path: join(root, 'missing.jsonl'), turns: [{ id: 'turn-1', items: [] }] },
    })
    expect(invalid).toEqual({
      thread: { id: 'thread-1', path: join(root, 'missing.jsonl'), turns: [{ id: 'turn-1', items: [] }] },
    })
  })
})
