import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyComponent, type ComponentGeneration } from './component.js'
import type { AccountAuthCoordinator } from '../accountAuthCoordinator.js'

afterEach(() => vi.useRealTimers())
describe('gateway owned recovery', () => {
  it('keeps 400 request-scoped and recovers after bounded 500 backoff without replay', async () => {
    vi.useFakeTimers()
    const coordinator = { isAccountOperationInProgress: () => false } as AccountAuthCoordinator
    const component = new ProxyComponent('/unused', coordinator)
    const generation = { process: { exitCode: null, signalCode: null }, expiresAt: new Date(Date.now() + 3600_000).toISOString() } as ComponentGeneration
    Object.assign(component, { current: generation, checkedAt: Date.now() })
    component.recordResult(generation, 400)
    expect(await component.prepare(null)).toBe(generation)
    component.recordResult(generation, 500)
    expect(component.status().ready).toBe(false)
    await expect(component.prepare(null)).rejects.toMatchObject({ code: 'component_backoff' })
    vi.advanceTimersByTime(1001)
    expect(await component.prepare(null)).toBe(generation)
    component.recordResult(generation, 200)
    expect(component.status()).toMatchObject({ ready: true, lastError: null, retryAt: null })
  })
  it('honors retry-after and ignores old-generation errors', () => {
    vi.useFakeTimers()
    const component = new ProxyComponent('/unused', {} as AccountAuthCoordinator)
    const generation = { process: { exitCode: null, signalCode: null } } as ComponentGeneration
    Object.assign(component, { current: generation })
    component.recordResult(generation, 429, '60')
    expect(Date.parse(component.status().retryAt!) - Date.now()).toBe(60_000)
    component.recordResult({} as ComponentGeneration, 500)
    expect(Date.parse(component.status().retryAt!) - Date.now()).toBe(60_000)
    component.recordResult(generation, 200)
    expect(component.status().ready).toBe(false)
  })
})
