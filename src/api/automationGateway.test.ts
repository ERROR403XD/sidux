import { describe, expect, it } from 'vitest'
import { subscribeCodexNotifications as subscribeFromAutomation } from './automationGateway'
import { subscribeRpcNotifications } from './codexRpcClient'

describe('automation gateway notifications', () => {
  it('uses the facade notification subscription implementation without duplication', () => {
    expect(subscribeFromAutomation).toBe(subscribeRpcNotifications)
  })
})
