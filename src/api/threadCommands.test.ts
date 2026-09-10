import { describe, expect, it, vi } from 'vitest'
vi.mock('./codexRpcClient', () => ({ rpcCall: vi.fn() }))
import { rpcCall } from './codexRpcClient'
import { validateGoalInput, parseGoalTokenBudget, formatGoalTokenBudget, getLatestCompletedReply, setThreadGoal, getGoalModelSettings, applyGoalModelSettings } from './threadCommands'
describe('native thread commands', () => {
  it('validates goals and budgets without silently inventing a limit', () => {
    expect(validateGoalInput(' 完成内部样本 ', '')).toEqual({ objective: '完成内部样本', tokenBudget: null })
    expect(validateGoalInput('目标', '1').tokenBudget).toBe(1)
    for (const value of ['0', '-1', 'NaN', '9007199254740992', '0.0000001M', '0.4', '0.0001k']) expect(() => validateGoalInput('目标', value)).toThrow('预算')
    expect(() => validateGoalInput(' ', '')).toThrow('目标')
    expect(() => validateGoalInput('字'.repeat(4001), '')).toThrow('目标')
  })
  it('accepts individual tokens, fractional k/M/B and lowercase units with exact persisted round trips', () => {
    for (const [input, tokens] of [['1', 1], ['100', 100], ['2k', 2000], ['0.4B', 400000000], ['0.001K', 1], ['9007199254740991', 9007199254740991], ['1.5M', 1500000], ['0.01B', 10000000], ['2b', 2000000000], ['0.003M', 3000], ['1.000001M', 1000001], ['0.000000001B', 1]] as const) {
      expect(parseGoalTokenBudget(input)).toBe(tokens)
      expect(parseGoalTokenBudget(formatGoalTokenBudget(tokens))).toBe(tokens)
    }
    expect(formatGoalTokenBudget(null)).toBe('')
    expect(formatGoalTokenBudget(3000)).toBe('3k')
    expect(formatGoalTokenBudget(1500000000)).toBe('1.5B')
  })
  it('uses native goal RPC; pause does not rewrite the objective or usage', async () => {
    vi.mocked(rpcCall).mockResolvedValue({ goal: { threadId: 'fixture', objective: 'sample', status: 'paused', tokensUsed: 12, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 } })
    await setThreadGoal('fixture', { status: 'paused' })
    expect(rpcCall).toHaveBeenLastCalledWith('thread/goal/set', { threadId: 'fixture', status: 'paused' })
  })
  it('reads persisted thread settings without history and updates only model and effort', async () => {
    vi.mocked(rpcCall).mockResolvedValueOnce({ thread: { model: 'gpt-6-astra', reasoningEffort: 'ultra' } })
    expect(await getGoalModelSettings('fixture')).toEqual({ model: 'gpt-6-astra', effort: 'ultra' })
    expect(rpcCall).toHaveBeenLastCalledWith('thread/read', { threadId: 'fixture', includeTurns: false })
    await applyGoalModelSettings('fixture', { model: 'gpt-5.6-luna', effort: 'max' })
    expect(rpcCall).toHaveBeenLastCalledWith('thread/settings/update', { threadId: 'fixture', model: 'gpt-5.6-luna', effort: 'max' })
  })
  it('copies only the last completed reply, excluding a newer in-progress answer', async () => {
    vi.mocked(rpcCall).mockResolvedValue({ thread: { turns: [{ status: 'completed', items: [{ type: 'agentMessage', text: '已完成回复' }] }, { status: 'inProgress', items: [{ type: 'agentMessage', text: '未完成回复' }] }] } })
    expect(await getLatestCompletedReply('fixture')).toBe('已完成回复')
  })
})
