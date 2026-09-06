import { describe, expect, it, vi } from 'vitest'
import { BackgroundTerminalReader } from './backgroundTerminalReader'
const row = { processId: '17', itemId: 'command-a', command: 'sleep 5', cwd: '/tmp' }

describe('Codex background terminal inventory and exact termination', () => {
  it('coalesces pending lists without caching completed inventory', async () => {
    const rpc = vi.fn(async () => ({ data: [row], nextCursor: null }))
    const reader = new BackgroundTerminalReader(rpc)
    await Promise.all([reader.list('a'), reader.list('a')])
    expect(rpc).toHaveBeenCalledTimes(1)
    await reader.list('a')
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('uses native processId only, rejects changed command identity and never invokes bulk cleanup', async () => {
    const rpc = vi.fn(async (method: string) => method.endsWith('/list') ? { data: [row], nextCursor: null } : { terminated: true })
    const reader = new BackgroundTerminalReader(rpc)
    await expect(reader.terminate('a', '17', 'old-command')).rejects.toThrow('另一条命令')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(await reader.terminate('a', 'missing', 'command-a')).toEqual({ absent: true, terminated: false })
    expect(await reader.terminate('a', '17', 'command-a')).toEqual({ absent: false, terminated: true })
    expect(rpc).toHaveBeenLastCalledWith('thread/backgroundTerminals/terminate', { threadId: 'a', processId: '17' })
    expect(rpc.mock.calls.some(([method]) => method.includes('clean'))).toBe(false)
  })
  it('does not repeat ambiguous stops and rejects concurrent stops or account transition', async () => {
    let release!: () => void
    let changing = false
    const rpc = vi.fn(async (method: string) => {
      if (method.endsWith('/list')) {
        await new Promise<void>(resolve => { release = resolve })
        return { data: [row], nextCursor: null }
      }
      throw new Error('lost response')
    })
    const reader = new BackgroundTerminalReader(rpc, () => changing)
    const first = reader.terminate('a', '17', 'command-a')
    await expect(reader.terminate('a', '17', 'command-a')).rejects.toThrow('正在处理')
    release()
    await expect(first).rejects.toThrow('lost response')
    expect(rpc.mock.calls.filter(([method]) => method.endsWith('/terminate'))).toHaveLength(1)
    const second = reader.terminate('a', '17', 'command-a')
    changing = true
    release()
    await expect(second).rejects.toThrow('正在切换')
    expect(rpc.mock.calls.filter(([method]) => method.endsWith('/terminate'))).toHaveLength(1)
  })
  it('bounds pagination and rejects repeated cursors or oversized pages', async () => {
    const repeated = new BackgroundTerminalReader(async () => ({ data: [], nextCursor: 'same' }))
    await expect(repeated.list('a')).rejects.toThrow('分页未前进')
    const large = new BackgroundTerminalReader(async () => ({ data: Array(21).fill(row), nextCursor: null }))
    await expect(large.list('a')).rejects.toThrow('响应无效')
    let cursor = 0
    const endless = new BackgroundTerminalReader(async () => ({ data: [row], nextCursor: String(cursor++) }))
    await expect(endless.list('a')).rejects.toThrow('超过 200')
    expect(cursor).toBe(10)
  })
})
