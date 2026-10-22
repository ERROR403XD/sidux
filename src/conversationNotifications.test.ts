import { expect, it } from 'vitest'
import { conversationNoticeEnabled, conversationNoticeLabel, conversationNoticeReceipt, createConversationNoticeClassifier, defaultConversationNoticePreferences, validateConversationNoticePreferences } from './conversationNotifications'
import { automaticResumeStartedMethod } from './threadAutomaticResume'

const completed = (turnId: string, extra = {}) => ({ method: 'turn/completed', params: { threadId: 'goal-thread', turn: { id: turnId, status: 'completed' }, ...extra } })

it('migrates existing preferences with GOAL progress disabled and rejects malformed new values', () => {
  const legacy = { postEnabled: true, states: { completed: false, quota: true, interrupted: false, automation: true } }
  expect(validateConversationNoticePreferences(legacy)).toEqual({ ...legacy, states: { ...legacy.states, resumeStarted: false }, goalProgressEnabled: false })
  expect(defaultConversationNoticePreferences().goalProgressEnabled).toBe(false)
  expect(() => validateConversationNoticePreferences({ ...legacy, goalProgressEnabled: 'false' })).toThrow()
  expect(() => validateConversationNoticePreferences({ ...legacy, goalProgressEnabled: null })).toThrow()
})

it.each(['quota', 'scheduled'] as const)('classifies confirmed %s resumptions independently of turn completion and GOAL progress', source => {
  const classify = createConversationNoticeClassifier()
  const preferences = defaultConversationNoticePreferences()
  const notice = classify({ method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: 'attempt', source, turnId: 'turn' } })!
  expect(notice.state).toBe('resumeStarted')
  expect(conversationNoticeEnabled(preferences, notice)).toBe(false)
  preferences.states.resumeStarted = true
  preferences.states.completed = false
  expect(conversationNoticeEnabled(preferences, notice)).toBe(true)
  expect(conversationNoticeLabel(notice)).toBe(source === 'quota' ? '额度恢复续跑已启动' : '定时续跑已启动')
  const done = classify(completed('turn', { threadId: 'thread' }))!
  expect(conversationNoticeReceipt(notice)).not.toBe(conversationNoticeReceipt(done))
  const goal = classify({ method: automaticResumeStartedMethod, params: { threadId: 'thread', deliveryId: 'goal-attempt', source } })!
  expect(goal.turnId).toBe('')
  expect(conversationNoticeReceipt(goal)).not.toBe(conversationNoticeReceipt(notice))
})

it('rejects malformed resume preferences and uncorrelated startup events', () => {
  const preferences = defaultConversationNoticePreferences()
  expect(validateConversationNoticePreferences(preferences).states.resumeStarted).toBe(false)
  for (const resumeStarted of ['true', null, 1]) {
    expect(() => validateConversationNoticePreferences({ ...preferences, states: { ...preferences.states, resumeStarted } })).toThrow()
  }
  const classify = createConversationNoticeClassifier()
  for (const params of [{ threadId: 'thread', source: 'quota' }, { deliveryId: 'attempt', source: 'quota' }, { threadId: 'thread', deliveryId: 'attempt', source: 'manual' }]) {
    expect(classify({ method: automaticResumeStartedMethod, params })).toBeNull()
  }
  expect(classify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'manual' } } })).toBeNull()
})

it('distinguishes ongoing GOAL stages from final and ordinary completions', () => {
  const classify = createConversationNoticeClassifier()
  classify({ method: 'thread/goal/updated', params: { threadId: 'goal-thread', goal: { status: 'active' } } })
  const stage = classify(completed('stage'))!
  expect(conversationNoticeEnabled(defaultConversationNoticePreferences(), stage)).toBe(false)
  expect(conversationNoticeLabel(stage)).toBe('GOAL 阶段完成')
  expect(conversationNoticeEnabled({ ...defaultConversationNoticePreferences(), goalProgressEnabled: true }, stage)).toBe(true)
  classify({ method: 'thread/goal/updated', params: { threadId: 'goal-thread', goal: { status: 'complete' } } })
  const final = classify(completed('final'))!
  expect(conversationNoticeEnabled(defaultConversationNoticePreferences(), final)).toBe(true)
  expect(conversationNoticeLabel(final)).toBe('会话任务已完成')
  classify({ method: 'thread/goal/updated', params: { threadId: 'goal-thread', goal: { status: 'active' } } })
  classify({ method: 'thread/goal/cleared', params: { threadId: 'goal-thread' } })
  expect(classify(completed('ordinary'))).toEqual({ threadId: 'goal-thread', turnId: 'ordinary', state: 'completed' })
})

it('uses server GOAL status after browser reconnect and clears stale local status', () => {
  const classify = createConversationNoticeClassifier()
  expect(classify(completed('after-refresh', { goalStatus: 'active' }))?.goalProgress).toBe(true)
  expect(classify(completed('after-clear', { goalStatus: null }))?.goalProgress).toBeUndefined()
  expect(classify(completed('resumed', { goalStatus: 'active' }))?.goalProgress).toBe(true)
  expect(classify(completed('finished', { goalStatus: 'complete' }))?.goalProgress).toBeUndefined()
})

it.each(['paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'])('preserves terminal notifications for %s GOAL status', goalStatus => {
  const event = createConversationNoticeClassifier()(completed('stopped', { goalStatus }))!
  expect(conversationNoticeEnabled(defaultConversationNoticePreferences(), event)).toBe(true)
  expect(event.goalProgress).toBeUndefined()
})

it('keeps progress under its completion category and never marks quota or interruption as a stage', () => {
  const classify = createConversationNoticeClassifier()
  const preferences = { ...defaultConversationNoticePreferences(), goalProgressEnabled: true }
  const automation = classify(completed('automation', { goalStatus: 'active', completionKind: 'background' }))!
  expect(automation.state).toBe('automation')
  preferences.states.automation = false
  expect(conversationNoticeEnabled(preferences, automation)).toBe(false)
  for (const message of ['quota exceeded', 'connection reset']) {
    const event = classify({ method: 'error', params: { threadId: 'goal-thread', turnId: message, error: { message } } })!
    expect(event.goalProgress).toBeUndefined()
    expect(conversationNoticeEnabled(defaultConversationNoticePreferences(), event)).toBe(true)
  }
  expect(classify(completed('other-thread', { threadId: 'ordinary-thread' }))?.goalProgress).toBeUndefined()
  expect(classify(completed('manual', { interruptionReason: 'user' }))).toBeNull()
})
