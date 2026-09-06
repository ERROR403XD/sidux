import { describe, expect, it } from 'vitest'
import { goalBudgetRemaining, goalResumeProblem, goalSavePatch, readThreadGoal, type ThreadGoal } from './threadGoal'

const goal: ThreadGoal = { threadId: 'g', objective: 'sample', status: 'blocked', tokenBudget: 1000, tokensUsed: 1200, timeUsedSeconds: 30, createdAt: 1, updatedAt: 2 }

describe('goal edits and budget boundaries', () => {
  it('never reactivates a terminal or blocked goal when only saving its budget', () => {
    for (const status of ['blocked', 'paused', 'budgetLimited', 'usageLimited', 'complete', 'active'] as const) {
      expect(goalSavePatch({ ...goal, status }, { objective: goal.objective, tokenBudget: null })).toEqual({ tokenBudget: null })
    }
    expect(goalSavePatch(goal, { objective: 'changed', tokenBudget: 2000 })).toEqual({ objective: 'changed', tokenBudget: 2000, status: 'paused' })
    expect(goalSavePatch(null, { objective: 'new', tokenBudget: null })).toEqual({ objective: 'new', tokenBudget: null, status: 'active' })
  })
  it('clamps remaining tokens without hiding over-budget usage and requires an increase before resume', () => {
    expect(goalBudgetRemaining(goal)).toBe(0)
    expect(goalResumeProblem(goal)).toContain('提高预算')
    expect(goalResumeProblem({ ...goal, tokensUsed: 1000 })).toContain('提高预算')
    expect(goalBudgetRemaining({ ...goal, tokenBudget: 2000 })).toBe(800)
    expect(goalResumeProblem({ ...goal, tokenBudget: null })).toBe('')
    expect(goal.tokensUsed).toBe(1200)
    expect(goalBudgetRemaining({ ...goal, tokensUsed: 0, timeUsedSeconds: 6 })).toBeNull()
  })
  it('rejects incomplete or mismatched snapshots instead of showing invented zero usage', () => {
    expect(readThreadGoal(goal, 'g')).toEqual(goal)
    expect(readThreadGoal(null, 'g')).toBeNull()
    for (const bad of [undefined, { ...goal, tokensUsed: undefined }, { ...goal, tokensUsed: -1 }, { ...goal, status: 'made-up' }, { ...goal, threadId: 'another' }]) {
      expect(() => readThreadGoal(bad, 'g')).toThrow('不完整')
    }
  })
})
