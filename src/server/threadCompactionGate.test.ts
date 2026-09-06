import { describe, expect, it, vi } from 'vitest'
import { ThreadCompactionGate } from './threadCompactionGate'

describe('manual compaction dispatch gate', () => {
  it('allows one native start across simultaneous tabs and releases it on its own completed turn', async () => {
    const rpc = vi.fn(async method => method === 'thread/read' ? { thread: { status: { type: 'idle' } } } : {})
    const gate = new ThreadCompactionGate(rpc)
    const first = gate.start('thread')
    await expect(gate.start('thread')).rejects.toThrow('正在提交')
    await first
    await expect(gate.start('thread')).rejects.toThrow('已有压缩')
    gate.observe({ method: 'item/started', params: { threadId: 'thread', turnId: 'compact-turn', item: { type: 'contextCompaction' } } })
    gate.observe({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'another' } } })
    await expect(gate.start('thread')).rejects.toThrow('已有压缩')
    gate.observe({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'compact-turn' } } })
    await gate.start('thread')
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/compact/start')).toHaveLength(2)
  })
  it('keeps ambiguous native submissions pending until an explicit new attempt and never starts busy threads', async () => {
    let status = 'idle'
    const rpc = vi.fn(async method => { if (method === 'thread/read') return { thread: { status: { type: status } } }; throw Error('connection lost') })
    const gate = new ThreadCompactionGate(rpc)
    await expect(gate.start('thread')).rejects.toThrow('connection lost')
    await expect(gate.start('thread')).rejects.toThrow('已有压缩')
    status = 'active'
    await expect(gate.start('thread', true)).rejects.toThrow('尚未空闲')
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/compact/start')).toHaveLength(1)
    status = 'notLoaded'
    await expect(gate.start('thread', true)).rejects.toThrow('尚未空闲')
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/compact/start')).toHaveLength(1)
    status = 'systemError'
    await expect(gate.start('thread', true)).rejects.toThrow('connection lost')
    expect(rpc.mock.calls.filter(([method]) => method === 'thread/compact/start')).toHaveLength(2)
  })
})
