import { describe, expect, it, vi } from 'vitest'
vi.mock('./codexRpcClient', () => ({ rpcCall: vi.fn() }))
import { rpcCall } from './codexRpcClient'
import { validateGoalInput, getLatestCompletedReply, setThreadGoal, compactThread } from './threadCommands'
describe('native thread commands', () => {
  it('validates goals and budgets without silently inventing a limit', () => {
    expect(validateGoalInput(' 完成内部样本 ', '')).toEqual({ objective: '完成内部样本', tokenBudget: null })
    expect(validateGoalInput('目标', '1000').tokenBudget).toBe(1000)
    for (const value of ['0', '-1', '2.5', 'NaN', '9007199254740992']) expect(() => validateGoalInput('目标', value)).toThrow('预算')
    expect(() => validateGoalInput(' ', '')).toThrow('目标')
    expect(() => validateGoalInput('字'.repeat(4001), '')).toThrow('目标')
  })
  it('uses native goal and compact RPC; pause does not rewrite the objective or usage', async () => {
    vi.mocked(rpcCall).mockResolvedValue({ goal: { status: 'paused' } })
    await setThreadGoal('fixture', { status: 'paused' })
    expect(rpcCall).toHaveBeenLastCalledWith('thread/goal/set', { threadId: 'fixture', status: 'paused' })
    await compactThread('fixture')
    expect(rpcCall).toHaveBeenLastCalledWith('thread/compact/start', { threadId: 'fixture' })
  })
  it('copies only the last completed reply, excluding a newer in-progress answer', async () => {
    vi.mocked(rpcCall).mockResolvedValue({ thread: { turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: '已完成回复' }] }, { status: 'inProgress', items: [{ type: 'agentMessage', text: '未完成回复' }] }] } })
    expect(await getLatestCompletedReply('fixture')).toBe('已完成回复')
  })
})
