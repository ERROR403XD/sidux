import { describe, expect, it } from 'vitest'
import { automationError } from './automationEngine'
describe('automation failure guidance', () => {
  it.each(['HTTP 429', 'quota exhausted', 'rate limit', '额度不足'])('keeps quota failures actionable without suggesting account switching: %s', message => {
    const result = automationError(new Error(message))
    expect(result.errorCode).toBe('QUOTA_EXHAUSTED')
    expect(result.error).toBe('额度或速率受限')
    expect(result.error).not.toMatch(/切换|改选|账号后重试/)
  })
  it('keeps authentication and network guidance separate', () => {
    expect(automationError(new Error('401 Unauthorized')).errorCode).toBe('AUTH_REQUIRED')
    expect(automationError(new Error('ECONNRESET')).errorCode).toBe('CONNECTION_ERROR')
  })
})
