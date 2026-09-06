import { describe, expect, it } from 'vitest'
import { AuthRecoveryRegistry, readAuthRecovery } from './authRecovery'

describe('auth recovery snapshot', () => {
  it('recovers the current phase on refresh without treating recovery as successful chat', () => {
    const states = new AuthRecoveryRegistry()
    const params = { threadId: 'a', turnId: 't', provider: 'openai', message: 'Refreshing credentials' }
    states.observe('modelProvider/authRecoveryStarted', params)
    expect(states.snapshot()[0].phase).toBe('started')
    states.observe('modelProvider/authRecoveryCompleted', params)
    expect(states.snapshot()[0].phase).toBe('completed')
    states.observe('turn/completed', { threadId: 'other', turn: { id: 't' } })
    expect(states.snapshot()).toHaveLength(1)
    states.observe('turn/completed', { threadId: 'a', turn: { id: 'old' } })
    expect(states.snapshot()).toHaveLength(1)
    states.observe('turn/completed', { threadId: 'a', turn: { id: 't' } })
    expect(states.snapshot()).toEqual([])
  })

  it('bounds retained states and clears them with the process', () => {
    const states = new AuthRecoveryRegistry()
    for (let i = 0; i < 150; i++) states.observe('modelProvider/authRecoveryStarted', { threadId: String(i), turnId: 't' })
    expect(states.snapshot()).toHaveLength(100)
    expect(readAuthRecovery({ threadId: 'a', phase: 'started' })).toBeNull()
    states.clear()
    expect(states.snapshot()).toEqual([])
  })
})
